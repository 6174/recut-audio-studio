#!/usr/bin/env python3
"""
[INPUT]: 读取 RECUT_MODELS_DIR、CosyVoice 官方仓库、CosyVoice2-0.5B 权重与本目录 whisper_shim。
[OUTPUT]: 对外提供 CosyVoice 专属运行时状态、声纹提取和零样本 WAV 合成，末行输出单行 JSON。
[POS]: audio-studio/python 的隔离 TTS worker；由 audio_runner 调用，绝不导入 Qwen3-ASR 或 App SQLite。
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import argparse
import importlib.util
import importlib.metadata
import json
import sys
from pathlib import Path


EXPECTED_VERSIONS = {
    "torch": "2.3.1",
    "torchaudio": "2.3.1",
    "transformers": "4.51.3",
    "numpy": "1.26.4",
}
REQUIRED_MODULES = ["onnxruntime", "soundfile", "tiktoken", "wetext"]


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)
    raise SystemExit(code)


def package_versions() -> dict[str, str]:
    versions = {}
    for name in EXPECTED_VERSIONS:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = ""
    return versions


def runtime_status() -> dict:
    versions = package_versions()
    mismatches = {name: {"expected": expected, "actual": versions[name]} for name, expected in EXPECTED_VERSIONS.items() if versions[name] != expected}
    missing = [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]
    return {"ready": not mismatches and not missing, "versions": versions, "mismatches": mismatches, "missing": missing}


def load_engine(model_dir: Path):
    repository = model_dir.parent.parent / "repository"
    runner_dir = str(Path(__file__).resolve().parent)
    for path in (runner_dir, str(repository), str(repository / "third_party" / "Matcha-TTS")):
        if path not in sys.path:
            sys.path.insert(0, path)
    import whisper_shim

    whisper_shim.install_whisper()
    whisper_shim.install_modelscope()
    whisper_shim.install_load_wav()
    from cosyvoice.cli.cosyvoice import CosyVoice2
    from cosyvoice.utils.file_utils import load_wav

    return CosyVoice2(str(model_dir), load_jit=False, load_trt=False, fp16=False), load_wav


def speaker(model_dir: Path, reference: Path) -> None:
    import torch

    engine, load_wav = load_engine(model_dir)
    embedding = engine.frontend._extract_spk_embedding(load_wav(str(reference), 16000))
    if not embedding.numel() or not bool(torch.isfinite(embedding).all()):
        emit({"ready": False, "error": "CosyVoice 无法从参考音提取有效声纹。"}, 1)
    norm = float(embedding.norm().item())
    if norm < 0.01:
        emit({"ready": False, "error": "参考音的声纹强度过低，无法建立声音角色。"}, 1)
    emit({"ready": True, "dimensions": int(embedding.numel()), "norm": round(norm, 4)})


def synthesize(model_dir: Path, text: str, prompt_text: str, reference: Path, output: Path) -> None:
    import soundfile as sf
    import torch

    engine, load_wav = load_engine(model_dir)
    prompt_wav = load_wav(str(reference), 16000)
    chunks = [chunk["tts_speech"].cpu() for chunk in engine.inference_zero_shot(text, prompt_text, prompt_wav)]
    if not chunks:
        emit({"ready": False, "error": "CosyVoice 没有返回音频。"}, 1)
    speech = torch.cat(chunks, dim=1)
    if not torch.isfinite(speech).all() or float(speech.abs().max()) < 0.002:
        emit({"ready": False, "error": "合成输出未通过波形质量检查。"}, 1)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), speech.squeeze(0).numpy(), engine.sample_rate, format="WAV", subtype="PCM_16")
    emit({"ready": True, "duration": round(float(speech.shape[1]) / engine.sample_rate, 3), "sampleRate": int(engine.sample_rate)})


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    speaker_parser = commands.add_parser("speaker")
    speaker_parser.add_argument("--model-dir", required=True)
    speaker_parser.add_argument("--reference", required=True)
    synthesize_parser = commands.add_parser("synthesize")
    synthesize_parser.add_argument("--model-dir", required=True)
    synthesize_parser.add_argument("--reference", required=True)
    synthesize_parser.add_argument("--prompt-text", required=True)
    synthesize_parser.add_argument("--text", required=True)
    synthesize_parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "status":
            result = runtime_status()
            emit(result, 0 if result["ready"] else 1)
        if args.command == "speaker":
            speaker(Path(args.model_dir), Path(args.reference))
        synthesize(Path(args.model_dir), args.text, args.prompt_text, Path(args.reference), Path(args.output))
    except SystemExit:
        raise
    except Exception as error:
        emit({"ready": False, "error": str(error)}, 1)


if __name__ == "__main__":
    main()
