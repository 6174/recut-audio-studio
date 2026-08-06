#!/usr/bin/env python3
"""
[INPUT]: 读取 RECUT_APP_FILES_DIR、RECUT_MODELS_DIR、faster-whisper、CosyVoice 官方仓库与 CosyVoice2-0.5B 权重、FFmpeg
[OUTPUT]: 输出单行 JSON 状态；实时报告模型下载、转写、角色准备与合成进度；在 App 私有 files/ 中生成 transcript.json/.srt 文稿字幕、16k 角色参考音与合成 wav
[POS]: audio-studio 的本地执行入口；依赖和模型固定到 .recut/models/audio-studio，不写入素材库
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

WHISPER_MODELS = ["whisper-small", "whisper-medium", "whisper-large-v3"]
WHISPER_MAP = {"whisper-small": "small", "whisper-medium": "medium", "whisper-large-v3": "large-v3"}
WHISPER_REPOS = {
    "whisper-small": "Systran/faster-whisper-small",
    "whisper-medium": "Systran/faster-whisper-medium",
    "whisper-large-v3": "Systran/faster-whisper-large-v3",
}
COSYVOICE_HF = "FunAudioLLM/CosyVoice2-0.5B"
COSYVOICE_MODEL_DIR = "cosyvoice/pretrained_models/CosyVoice2-0.5B"
COSYVOICE_REPOSITORY = "cosyvoice/repository"
MAX_REFERENCE_SECONDS = 30.0
STYLES = {
    "neutral": "",
    "calm": "用平静舒缓的语气朗读。",
    "excited": "用兴奋热情的语气朗读。",
    "gentle": "用温柔的语气朗读。",
}


def model_root() -> Path:
    return Path(os.environ.get("RECUT_MODELS_DIR", Path.home() / ".recut" / "models")) / "audio-studio"


def files_root() -> Path:
    value = os.environ.get("RECUT_APP_FILES_DIR")
    if not value:
        raise RuntimeError("RECUT_APP_FILES_DIR is missing")
    return Path(value).resolve()


def safe_file(relative: str) -> Path:
    root = files_root()
    target = (root / relative).resolve()
    if target == root or root not in target.parents:
        raise RuntimeError("input or output path escapes the App file sandbox")
    return target


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=True))
    raise SystemExit(code)


def display_size(size: float) -> str:
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KiB"
    return f"{size / (1024 * 1024):.1f} MiB"


def download_repo(repo_id: str, target_dir: Path, cache: bool) -> None:
    """Per-file download with readable byte progress; keeps HuggingFace's own tqdm quiet."""
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    from huggingface_hub import hf_hub_download, repo_info

    info = repo_info(repo_id, files_metadata=True)
    siblings = [item for item in info.siblings if item.rfilename != ".gitattributes"]
    total = sum(item.size or 0 for item in siblings)
    downloaded = 0
    print(f"[audio] 正在下载 {repo_id}（{display_size(total)}）。", flush=True)
    for item in siblings:
        size = item.size or 0
        print(f"[audio] 开始下载 {item.rfilename}（{display_size(size)}）。", flush=True)
        if cache:
            hf_hub_download(repo_id, item.rfilename, cache_dir=str(target_dir))
        else:
            hf_hub_download(repo_id, item.rfilename, local_dir=str(target_dir))
        downloaded += size
        print(f"[audio] 已下载 {display_size(downloaded)} / {display_size(total)}（{item.rfilename}）。", flush=True)
    print(f"[audio] {repo_id} 下载完成。", flush=True)


def whisper_dir() -> Path:
    return model_root() / "whisper"


def cosyvoice_repo() -> Path:
    return model_root() / COSYVOICE_REPOSITORY


def cosyvoice_model() -> Path:
    return model_root() / COSYVOICE_MODEL_DIR


def state(root: Path) -> dict:
    problems = []
    if not shutil.which("ffmpeg"):
        problems.append("FFmpeg is not available on PATH. Install it, then retry.")
    whisper = whisper_dir()
    installed = [name for name in WHISPER_MODELS if (whisper / f"models--Systran--faster-whisper-{WHISPER_MAP[name]}").is_dir()]
    repository_ready = (cosyvoice_repo() / "cosyvoice" / "cli" / "cosyvoice.py").is_file() and (cosyvoice_repo() / "third_party" / "Matcha-TTS" / "matcha").is_dir()
    model_ready = (cosyvoice_model() / "cosyvoice2.yaml").is_file()
    if not repository_ready:
        problems.append("CosyVoice 官方仓库或 Matcha-TTS 子模块尚未准备。")
    return {
        "ready": not problems,
        "modelsRoot": str(root),
        "asr": {"installed": installed},
        "tts": {"repository": repository_ready, "model": model_ready, "ready": repository_ready and model_ready},
        "error": " ".join(problems),
    }


def extract_audio(source: Path, target: Path) -> None:
    command = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(target)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"Could not extract audio: {result.stderr.strip()}")


def probe_duration(path: Path) -> float:
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], capture_output=True, text=True)
    try:
        data = json.loads(result.stdout or "{}")
        return float(data.get("format", {}).get("duration") or 0)
    except ValueError:
        return 0.0


def install(selected: str) -> None:
    if selected in WHISPER_MODELS:
        target = whisper_dir()
        target.mkdir(parents=True, exist_ok=True)
        download_repo(WHISPER_REPOS[selected], target, cache=True)
        print(f"[audio] {selected} 模型已就绪。", flush=True)
    elif selected == "cosyvoice2":
        target = cosyvoice_model()
        target.mkdir(parents=True, exist_ok=True)
        download_repo(COSYVOICE_HF, target, cache=False)
        print("[audio] CosyVoice2-0.5B 权重已就绪。", flush=True)
    else:
        emit({"ready": False, "error": f"unknown install target {selected}"}, 1)
    emit(state(model_root()))


def format_timecode(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(milliseconds, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def build_srt(segments: list) -> str:
    blocks = []
    for index, segment in enumerate(segments, start=1):
        blocks.append(f"{index}\n{format_timecode(segment['start'])} --> {format_timecode(segment['end'])}\n{segment['text']}\n")
    return "\n".join(blocks)


def load_whisper(model_id: str):
    from faster_whisper import WhisperModel

    return WhisperModel(WHISPER_MAP[model_id], device="cpu", compute_type="int8", download_root=str(whisper_dir()))


def transcribe(model_id: str, language: str, source_relative: str, stem_relative: str) -> None:
    current = state(model_root())
    if not current["ready"] or model_id not in WHISPER_MODELS:
        emit({"ready": False, "error": current["error"] or f"Model {model_id} has not been installed."}, 1)
    source = safe_file(source_relative)
    stem = safe_file(stem_relative)
    stem.parent.mkdir(parents=True, exist_ok=True)
    audio = stem.with_suffix(".input.wav")
    try:
        print("[audio] 正在抽取音频轨道。", flush=True)
        extract_audio(source, audio)
        print(f"[audio] 正在加载 {model_id} 模型。", flush=True)
        whisper = load_whisper(model_id)
        language_code = None if language in ("", "auto") else language
        print("[audio] 开始转写。", flush=True)
        segments, info = whisper.transcribe(str(audio), language=language_code, vad_filter=True)
        entries = []
        for segment in segments:
            entry = {"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": segment.text.strip(), "speaker": "", "emotion": ""}
            entries.append(entry)
            print(f"[audio] {format_timecode(segment.start)} → {format_timecode(segment.end)}：{entry['text']}", flush=True)
        transcript = {
            "model": model_id,
            "language": info.language,
            "languageProbability": round(float(info.language_probability), 4),
            "duration": round(float(info.duration), 3),
            "segments": entries,
        }
        json_path = stem.with_suffix(".json")
        srt_path = stem.with_suffix(".srt")
        json_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
        srt_path.write_text(build_srt(entries), encoding="utf-8")
        print(f"[audio] 转写完成：{len(entries)} 段，{transcript['duration']:.1f} 秒。", flush=True)
        emit({"ready": True, "output": stem_relative, "language": info.language, "segments": len(entries), "srt": str(srt_path.relative_to(files_root())), "transcript": str(json_path.relative_to(files_root()))})
    finally:
        audio.unlink(missing_ok=True)


def prepare_character(model_id: str, source_relative: str, stem_relative: str) -> None:
    current = state(model_root())
    if not current["ready"] or model_id not in WHISPER_MODELS:
        emit({"ready": False, "error": current["error"] or f"Model {model_id} has not been installed."}, 1)
    source = safe_file(source_relative)
    stem = safe_file(stem_relative)
    stem.parent.mkdir(parents=True, exist_ok=True)
    wav = stem.with_suffix(".wav")
    print("[audio] 正在准备 16k 参考音频。", flush=True)
    extract_audio(source, wav)
    duration = probe_duration(wav)
    if duration > MAX_REFERENCE_SECONDS:
        print(f"[audio] 参考音频 {duration:.1f}s 超过 30 秒，已裁剪到前 30 秒。", flush=True)
        trimmed = stem.with_name(stem.name + ".trim.wav")
        result = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-t", "30", "-c:a", "pcm_s16le", str(trimmed)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f"Could not trim reference audio: {result.stderr.strip()}")
        wav.unlink(missing_ok=True)
        trimmed.replace(wav)
        duration = 30.0
    print(f"[audio] 正在用 {model_id} 转写参考音，生成角色提示词。", flush=True)
    whisper = load_whisper(model_id)
    segments, info = whisper.transcribe(str(wav), vad_filter=True)
    prompt_text = "".join(segment.text.strip() for segment in segments)
    meta = {"wav": str(wav.relative_to(files_root())), "promptText": prompt_text, "duration": round(duration, 3), "language": info.language}
    Path(str(wav) + ".meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[audio] 角色参考音已就绪（{duration:.1f}s）。", flush=True)
    emit({"ready": True, **meta})


def synthesize(text: str, reference_relative: str, prompt_text: str, style: str, output_relative: str) -> None:
    current = state(model_root())
    if not current["ready"]:
        emit(current, 1)
    repository = cosyvoice_repo()
    model_dir = cosyvoice_model()
    if not current["tts"]["ready"]:
        emit({"ready": False, "error": "CosyVoice 运行环境未就绪：请先安装官方仓库（含 Matcha-TTS 子模块）并下载 CosyVoice2-0.5B 权重。"}, 1)
    reference = safe_file(reference_relative)
    output = safe_file(output_relative)
    output.parent.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(repository))
    matcha = repository / "third_party" / "Matcha-TTS"
    if matcha.is_dir():
        sys.path.insert(0, str(matcha))
    import whisper_shim

    whisper_shim.install_whisper()
    whisper_shim.install_modelscope()
    try:
        print("[audio] 正在加载 CosyVoice2 模型（首次加载较慢）。", flush=True)
        from cosyvoice.cli.cosyvoice import CosyVoice2
        from cosyvoice.utils.file_utils import load_wav

        import torch
        import torchaudio

        engine = CosyVoice2(str(model_dir), load_jit=False, load_trt=False, fp16=False)
        sample_rate = engine.sample_rate
        prompt_wav = load_wav(str(reference), 16000)
        instruct_text = STYLES.get(style, "")
        if instruct_text:
            print(f"[audio] 使用情绪指令：{instruct_text}", flush=True)
            generator = engine.inference_instruct2(text, instruct_text, prompt_wav)
        else:
            generator = engine.inference_zero_shot(text, prompt_text, prompt_wav)
        chunks = []
        for chunk in generator:
            chunks.append(chunk["tts_speech"].cpu())
        if not chunks:
            raise RuntimeError("synthesis produced no audio")
        speech = torch.cat(chunks, dim=1)
        torchaudio.save(str(output), speech, sample_rate, encoding="PCM_S", bits_per_sample=16)
        duration = float(speech.shape[1]) / sample_rate
        meta = {"wav": str(output.relative_to(files_root())), "duration": round(duration, 3), "sampleRate": int(sample_rate), "style": style}
        Path(str(output) + ".meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[audio] 合成完成：{duration:.1f} 秒。", flush=True)
        emit({"ready": True, **meta})
    except Exception as error:
        emit({"ready": False, "error": str(error)}, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--model", choices=WHISPER_MODELS + ["cosyvoice2"], required=True)
    transcribe_parser = commands.add_parser("transcribe")
    transcribe_parser.add_argument("--model", choices=WHISPER_MODELS, required=True)
    transcribe_parser.add_argument("--language", choices=["auto", "zh", "en"], required=True)
    transcribe_parser.add_argument("--input", required=True)
    transcribe_parser.add_argument("--output", required=True)
    character_parser = commands.add_parser("character")
    character_parser.add_argument("--model", choices=WHISPER_MODELS, required=True)
    character_parser.add_argument("--input", required=True)
    character_parser.add_argument("--output", required=True)
    synthesize_parser = commands.add_parser("synthesize")
    synthesize_parser.add_argument("--text", required=True)
    synthesize_parser.add_argument("--reference", required=True)
    synthesize_parser.add_argument("--prompt-text", default="")
    synthesize_parser.add_argument("--style", choices=list(STYLES), default="neutral")
    synthesize_parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "status":
            emit(state(model_root()))
        elif args.command == "install":
            install(args.model)
        elif args.command == "transcribe":
            transcribe(args.model, args.language, args.input, args.output)
        elif args.command == "character":
            prepare_character(args.model, args.input, args.output)
        elif args.command == "synthesize":
            synthesize(args.text, args.reference, args.prompt_text, args.style, args.output)
    except SystemExit:
        raise
    except Exception as error:
        emit({"ready": False, "error": str(error)}, 1)


if __name__ == "__main__":
    main()
