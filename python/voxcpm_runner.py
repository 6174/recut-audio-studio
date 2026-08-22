#!/usr/bin/env python3
"""
[INPUT]: 读取 RECUT_MODELS_DIR、VoxCPM 权重目录、声音角色参考音与文本
[OUTPUT]: 对外提供 VoxCPM 专属运行时状态与语音合成（克隆 / Voice Design），持续输出模型加载/推理阶段日志，末行输出单行 JSON
[POS]: audio-studio/python 的隔离 VoxCPM worker；由 audio_runner 调用，绝不导入 Qwen3-ASR、CosyVoice 或 App SQLite
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import sys
from pathlib import Path

# VoxCPM 的 Voice Design 默认音描述：VoxCPM2 用它生成无需参考音的中性人声。
VOXCPM_DESIGN_DESC = "一位年轻、温和的中文女声，语气自然亲切"
MIN_TORCH_VERSION = (2, 5, 0)


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)
    raise SystemExit(code)


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return ""


def torch_version_tuple() -> tuple | None:
    version = package_version("torch")
    if not version:
        return None
    cleaned = version.split("+")[0].split(".")[:3]
    try:
        parts = [int(part) for part in cleaned]
        while len(parts) < 3:
            parts.append(0)
        return tuple(parts)
    except ValueError:
        return None


def runtime_status() -> dict:
    versions = {
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "torch": package_version("torch"),
        "torchaudio": package_version("torchaudio"),
        "transformers": package_version("transformers"),
        "voxcpm": package_version("voxcpm"),
    }
    problems = []
    if not importlib.util.find_spec("voxcpm"):
        problems.append("voxcpm 包未安装")
    if not versions["torch"]:
        problems.append("torch 未安装")
    elif (torch_version_tuple() or (0, 0, 0)) < MIN_TORCH_VERSION:
        problems.append(f"torch 版本过低（需 >= {'.'.join(map(str, MIN_TORCH_VERSION))}）")
    if problems:
        return {"ready": False, "versions": versions, "error": "；".join(problems)}
    return {"ready": True, "versions": versions}


def load_engine(model_dir: Path):
    print("[audio] VoxCPM worker：正在加载模型权重（首次加载较慢）。", flush=True)
    from voxcpm import VoxCPM

    # optimize=False 关闭 torch.compile 预热（MPS 上不受支持）；load_denoiser=False
    # 避免下载 ModelScope 降噪器。device=None 自动选择 CUDA → MPS → CPU。
    engine = VoxCPM.from_pretrained(
        str(model_dir),
        load_denoiser=False,
        optimize=False,
        device=None,
    )
    print(f"[audio] VoxCPM worker：模型已就绪（{engine.tts_model.sample_rate} Hz）。", flush=True)
    return engine


def synthesize(version: str, model_dir: Path, reference: Path | None, prompt_text: str, text: str, output: Path, voice_design: bool = False) -> None:
    import numpy as np
    import soundfile as sf

    is_v2 = version == "voxcpm2"
    if reference is not None:
        if not reference.is_file():
            emit({"ready": False, "error": f"声音角色参考音不可用：{reference}"}, 1)
        print("[audio] VoxCPM worker：正在使用声音角色参考音克隆音色。", flush=True)
    elif voice_design and is_v2:
        print("[audio] VoxCPM worker：正在用 Voice Design 生成默认音色（无需参考音）。", flush=True)
    else:
        emit({"ready": False, "error": "VoxCPM 该版本需要声音角色参考音；仅 VoxCPM2 支持 Voice Design 默认音。"}, 1)

    engine = load_engine(model_dir)
    kwargs = {"text": text, "cfg_value": 2.0, "inference_timesteps": 10}
    if reference is not None:
        if is_v2:
            kwargs["reference_wav_path"] = str(reference)
        else:
            if not prompt_text.strip():
                emit({"ready": False, "error": "延续式克隆需要参考音的对应转写文本（角色提示词）。"}, 1)
            kwargs["prompt_wav_path"] = str(reference)
            kwargs["prompt_text"] = prompt_text
    else:
        # VoxCPM2 Voice Design：用自然语言描述直接设计音色，无需参考音。
        kwargs["text"] = f"({VOXCPM_DESIGN_DESC}){text}"

    print(f"[audio] VoxCPM worker：开始推理，共 {len(kwargs['text'])} 个文本字符。", flush=True)
    wav = engine.generate(**kwargs)
    speech = np.asarray(wav, dtype=np.float32).reshape(-1)
    if not speech.size or not np.isfinite(speech).all() or float(np.max(np.abs(speech))) < 0.002:
        emit({"ready": False, "error": "合成输出未通过波形质量检查。"}, 1)
    sample_rate = int(engine.tts_model.sample_rate)
    output.parent.mkdir(parents=True, exist_ok=True)
    print("[audio] VoxCPM worker：正在写入 WAV。", flush=True)
    sf.write(str(output), speech, sample_rate, format="WAV", subtype="PCM_16")
    print("[audio] VoxCPM worker：WAV 写入完成。", flush=True)
    emit({"ready": True, "duration": round(float(speech.size) / sample_rate, 3), "sampleRate": sample_rate})


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    synthesize_parser = commands.add_parser("synthesize")
    synthesize_parser.add_argument("--version", choices=["voxcpm2", "voxcpm1.5", "voxcpm-0.5b"], required=True)
    synthesize_parser.add_argument("--model-dir", required=True)
    synthesize_parser.add_argument("--reference", default="")
    synthesize_parser.add_argument("--prompt-text", default="")
    synthesize_parser.add_argument("--voice-design", action="store_true")
    synthesize_parser.add_argument("--text", required=True)
    synthesize_parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "status":
            result = runtime_status()
            emit(result, 0 if result["ready"] else 1)
        reference = Path(args.reference) if args.reference else None
        synthesize(args.version, Path(args.model_dir), reference, args.prompt_text, args.text, Path(args.output), args.voice_design)
    except SystemExit:
        raise
    except Exception as error:
        emit({"ready": False, "error": str(error)}, 1)


if __name__ == "__main__":
    main()