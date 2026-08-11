#!/usr/bin/env python3
"""
[INPUT]: 读取 RECUT_APP_FILES_DIR、RECUT_MODELS_DIR、faster-whisper、Qwen3-ASR、CosyVoice 官方仓库与 CosyVoice2-0.5B 权重、FFmpeg
[OUTPUT]: 输出单行 JSON 状态；实时报告模型下载、转写、角色准备与合成进度；在 App 私有 files/ 中生成 transcript.json/.srt 文稿字幕、保留与时间戳对齐的源声音轨、16k 角色参考音与合成 wav
[POS]: audio-studio 的本地执行入口；依赖和模型固定到 .recut/models/audio-studio，不写入素材库
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import argparse
import importlib.util
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
QWEN_MODELS = ["qwen3-asr-0.6b", "qwen3-asr-1.7b"]
QWEN_REPOS = {
    "qwen3-asr-0.6b": "Qwen/Qwen3-ASR-0.6B",
    "qwen3-asr-1.7b": "Qwen/Qwen3-ASR-1.7B",
}
QWEN_ALIGNER_REPO = "Qwen/Qwen3-ForcedAligner-0.6B"
QWEN_LANGUAGE_MAP = {"auto": None, "zh": "Chinese", "en": "English"}
ASR_MODELS = WHISPER_MODELS + QWEN_MODELS
DOWNLOAD_SOURCES = {"automatic", "huggingface", "modelscope"}
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


def download_huggingface_repo(repo_id: str, target_dir: Path, cache: bool = False) -> None:
    """Download into the App-owned model directory with readable progress."""
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


def download_modelscope_repo(repo_id: str, target_dir: Path) -> None:
    from modelscope import snapshot_download

    print(f"[audio] 正在从 ModelScope 下载 {repo_id}。", flush=True)
    snapshot_download(repo_id, local_dir=str(target_dir))
    print(f"[audio] {repo_id} 下载完成。", flush=True)


def download_repo(repo_id: str, target_dir: Path, source: str) -> None:
    if source not in DOWNLOAD_SOURCES:
        raise RuntimeError(f"unknown download source {source}")
    target_dir.mkdir(parents=True, exist_ok=True)
    if source == "huggingface":
        download_huggingface_repo(repo_id, target_dir)
        return
    if source == "modelscope":
        download_modelscope_repo(repo_id, target_dir)
        return
    try:
        print(f"[audio] 自动下载：先尝试 Hugging Face。", flush=True)
        download_huggingface_repo(repo_id, target_dir)
    except Exception as error:
        print(f"[audio] Hugging Face 不可用（{error}），改用 ModelScope。", flush=True)
        download_modelscope_repo(repo_id, target_dir)


def whisper_dir() -> Path:
    return model_root() / "whisper"


def whisper_model(model_id: str) -> Path:
    return whisper_dir() / model_id


def downloaded_whisper(model_id: str) -> bool:
    cache_dir = whisper_dir() / f"models--Systran--faster-whisper-{WHISPER_MAP[model_id]}"
    direct_dir = whisper_model(model_id)
    return cache_dir.is_dir() or ((direct_dir / "config.json").is_file() and (direct_dir / "model.bin").is_file())


def download_whisper(model_id: str, source: str) -> None:
    repo_id = WHISPER_REPOS[model_id]
    if source == "huggingface":
        download_huggingface_repo(repo_id, whisper_dir(), cache=True)
        return
    if source == "modelscope":
        download_modelscope_repo(repo_id, whisper_model(model_id))
        return
    try:
        print("[audio] 自动下载：先尝试 Hugging Face。", flush=True)
        download_huggingface_repo(repo_id, whisper_dir(), cache=True)
    except Exception as error:
        print(f"[audio] Hugging Face 不可用（{error}），改用 ModelScope。", flush=True)
        download_modelscope_repo(repo_id, whisper_model(model_id))


def qwen_dir() -> Path:
    return model_root() / "qwen3-asr"


def qwen_model(model_id: str) -> Path:
    return qwen_dir() / QWEN_REPOS[model_id].split("/")[-1]


def qwen_aligner() -> Path:
    return qwen_dir() / QWEN_ALIGNER_REPO.split("/")[-1]


def downloaded_model(path: Path) -> bool:
    return (path / "config.json").is_file() and any(path.glob("*.safetensors"))


def qwen_runtime_available() -> bool:
    """A downloaded Qwen checkpoint is usable only with the official runtime package."""
    return importlib.util.find_spec("qwen_asr") is not None


def cosyvoice_repo() -> Path:
    return model_root() / COSYVOICE_REPOSITORY


def cosyvoice_model() -> Path:
    return model_root() / COSYVOICE_MODEL_DIR


def state(root: Path) -> dict:
    problems = []
    if not shutil.which("ffmpeg"):
        problems.append("FFmpeg is not available on PATH. Install it, then retry.")
    whisper = whisper_dir()
    installed = [name for name in WHISPER_MODELS if downloaded_whisper(name)]
    aligner_ready = downloaded_model(qwen_aligner())
    qwen_installed = [name for name in QWEN_MODELS if downloaded_model(qwen_model(name)) and aligner_ready]
    qwen_runtime_ready = qwen_runtime_available()
    if qwen_installed and not qwen_runtime_ready:
        problems.append("Qwen3-ASR 运行依赖缺失，请重新准备声音工坊运行环境。")
    elif qwen_runtime_ready:
        installed.extend(qwen_installed)
    repository_ready = (cosyvoice_repo() / "cosyvoice" / "cli" / "cosyvoice.py").is_file() and (cosyvoice_repo() / "third_party" / "Matcha-TTS" / "matcha").is_dir()
    model_ready = (cosyvoice_model() / "cosyvoice2.yaml").is_file()
    if not repository_ready:
        problems.append("CosyVoice 官方仓库或 Matcha-TTS 子模块尚未准备。")
    return {
        "ready": not problems,
        "modelsRoot": str(root),
        "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
        "asr": {"installed": installed, "qwenRuntime": qwen_runtime_ready},
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


def install(selected: str, source: str) -> None:
    if selected in WHISPER_MODELS:
        download_whisper(selected, source)
        print(f"[audio] {selected} 模型已就绪。", flush=True)
    elif selected in QWEN_MODELS:
        target = qwen_model(selected)
        download_repo(QWEN_REPOS[selected], target, source)
        if not downloaded_model(qwen_aligner()):
            print("[audio] 正在下载 Qwen 时间戳对齐器。", flush=True)
            download_repo(QWEN_ALIGNER_REPO, qwen_aligner(), source)
        print(f"[audio] {selected} 模型与时间戳对齐器已就绪。", flush=True)
    elif selected == "cosyvoice2":
        target = cosyvoice_model()
        download_repo(COSYVOICE_HF, target, source)
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

    direct_dir = whisper_model(model_id)
    source = str(direct_dir) if downloaded_whisper(model_id) and (direct_dir / "model.bin").is_file() else WHISPER_MAP[model_id]
    return WhisperModel(source, device="cpu", compute_type="int8", download_root=str(whisper_dir()))


def load_qwen(model_id: str):
    import torch
    from qwen_asr import Qwen3ASRModel

    use_cuda = torch.cuda.is_available()
    return Qwen3ASRModel.from_pretrained(
        str(qwen_model(model_id)),
        dtype=torch.bfloat16 if use_cuda else torch.float32,
        device_map="cuda:0" if use_cuda else "cpu",
        forced_aligner=str(qwen_aligner()),
        forced_aligner_kwargs={"dtype": torch.bfloat16 if use_cuda else torch.float32, "device_map": "cuda:0" if use_cuda else "cpu"},
        max_inference_batch_size=1,
        max_new_tokens=4096,
    )


def join_aligned_text(current: str, next_text: str) -> str:
    if current and next_text and current[-1].isascii() and current[-1].isalnum() and next_text[0].isascii() and next_text[0].isalnum():
        return f"{current} {next_text}"
    return f"{current}{next_text}"


def qwen_segments(time_stamps: object, duration: float) -> list:
    units = []
    for item in time_stamps or []:
        text = str(getattr(item, "text", "")).strip()
        start = float(getattr(item, "start_time", 0) or 0)
        end = float(getattr(item, "end_time", start) or start)
        if text and end >= start:
            units.append({"start": start, "end": end, "text": text})
    entries = []
    current = None
    for unit in units:
        if current is None:
            current = {"start": unit["start"], "end": unit["end"], "text": unit["text"]}
            continue
        current["text"] = join_aligned_text(current["text"], unit["text"])
        current["end"] = unit["end"]
        ends_sentence = unit["text"].endswith(("。", "！", "？", ".", "!", "?", "；", ";"))
        too_long = len(current["text"]) >= 28 or current["end"] - current["start"] >= 6
        if ends_sentence or too_long:
            entries.append({"start": round(current["start"], 3), "end": round(current["end"], 3), "text": current["text"], "speaker": "", "emotion": ""})
            current = None
    if current is not None:
        entries.append({"start": round(current["start"], 3), "end": round(current["end"], 3), "text": current["text"], "speaker": "", "emotion": ""})
    if entries:
        return entries
    raise RuntimeError(f"Qwen 时间戳对齐器没有返回有效结果（音频时长 {duration:.1f}s）。")


def transcribe_whisper(model_id: str, audio: Path, language: str) -> tuple[list, str, float, float]:
    whisper = load_whisper(model_id)
    language_code = None if language in ("", "auto") else language
    segments, info = whisper.transcribe(str(audio), language=language_code, vad_filter=True)
    entries = []
    for segment in segments:
        entry = {"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": segment.text.strip(), "speaker": "", "emotion": ""}
        entries.append(entry)
        print(f"[audio] {format_timecode(segment.start)} → {format_timecode(segment.end)}：{entry['text']}", flush=True)
    return entries, info.language, float(info.language_probability), float(info.duration)


def transcribe_qwen(model_id: str, audio: Path, language: str) -> tuple[list, str, float, float]:
    duration = probe_duration(audio)
    qwen = load_qwen(model_id)
    results = qwen.transcribe(audio=str(audio), language=QWEN_LANGUAGE_MAP[language], return_time_stamps=True)
    if not results:
        raise RuntimeError("Qwen 未返回转写结果。")
    result = results[0]
    entries = qwen_segments(getattr(result, "time_stamps", None), duration)
    for entry in entries:
        print(f"[audio] {format_timecode(entry['start'])} → {format_timecode(entry['end'])}：{entry['text']}", flush=True)
    return entries, str(getattr(result, "language", "")), 1.0, duration


def transcribe(model_id: str, language: str, source_relative: str, stem_relative: str) -> None:
    current = state(model_root())
    if not current["ready"] or model_id not in ASR_MODELS or model_id not in current["asr"]["installed"]:
        emit({"ready": False, "error": current["error"] or f"Model {model_id} has not been installed."}, 1)
    source = safe_file(source_relative)
    stem = safe_file(stem_relative)
    stem.parent.mkdir(parents=True, exist_ok=True)
    audio = stem.with_suffix(".audio.wav")
    try:
        print("[audio] 正在抽取音频轨道。", flush=True)
        extract_audio(source, audio)
        print(f"[audio] 正在加载 {model_id} 模型。", flush=True)
        print("[audio] 开始转写。", flush=True)
        entries, detected_language, probability, duration = transcribe_whisper(model_id, audio, language) if model_id in WHISPER_MODELS else transcribe_qwen(model_id, audio, language)
        transcript = {
            "model": model_id,
            "language": detected_language,
            "languageProbability": round(probability, 4),
            "duration": round(duration, 3),
            "segments": entries,
        }
        json_path = stem.with_suffix(".json")
        srt_path = stem.with_suffix(".srt")
        json_path.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
        srt_path.write_text(build_srt(entries), encoding="utf-8")
        print(f"[audio] 转写完成：{len(entries)} 段，{transcript['duration']:.1f} 秒。", flush=True)
        # Keep the extracted audio track so the transcript can later be saved
        # to the media library as a single audio + SRT + JSON bundle.
        emit({"ready": True, "output": stem_relative, "language": detected_language, "segments": len(entries), "srt": str(srt_path.relative_to(files_root())), "transcript": str(json_path.relative_to(files_root())), "audio": str(audio.relative_to(files_root()))})
    finally:
        if audio.exists() and audio.stat().st_size == 0:
            audio.unlink(missing_ok=True)


def prepare_character(model_id: str, source_relative: str, stem_relative: str) -> None:
    current = state(model_root())
    if not current["ready"] or model_id not in ASR_MODELS or model_id not in current["asr"]["installed"]:
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
    entries, detected_language, _, _ = transcribe_whisper(model_id, wav, "auto") if model_id in WHISPER_MODELS else transcribe_qwen(model_id, wav, "auto")
    prompt_text = "".join(entry["text"] for entry in entries)
    meta = {"wav": str(wav.relative_to(files_root())), "promptText": prompt_text, "duration": round(duration, 3), "language": detected_language}
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
    install_parser.add_argument("--model", choices=ASR_MODELS + ["cosyvoice2"], required=True)
    install_parser.add_argument("--source", choices=sorted(DOWNLOAD_SOURCES), default="automatic")
    transcribe_parser = commands.add_parser("transcribe")
    transcribe_parser.add_argument("--model", choices=ASR_MODELS, required=True)
    transcribe_parser.add_argument("--language", choices=["auto", "zh", "en"], required=True)
    transcribe_parser.add_argument("--input", required=True)
    transcribe_parser.add_argument("--output", required=True)
    character_parser = commands.add_parser("character")
    character_parser.add_argument("--model", choices=ASR_MODELS, required=True)
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
            install(args.model, args.source)
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
