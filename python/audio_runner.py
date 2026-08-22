#!/usr/bin/env python3
"""
[INPUT]: 读取 RECUT_APP_FILES_DIR、RECUT_MODELS_DIR、主 ASR venv、CosyVoice 专属官方 venv、VoxCPM 专属 venv、模型权重与 FFmpeg
[OUTPUT]: 输出单行 JSON 状态；实时报告模型下载、转写、角色准备与合成进度，并在底层模型静默时每 8 秒输出心跳；在 App 私有 files/ 中生成 transcript.json/.srt 文稿字幕、经连续语音/波形/声纹验收的 16k 角色参考音与合成 wav
[POS]: audio-studio 的本地执行入口；实现 VoiceCloneEngine 的参考音预处理、片段筛选、质量验收和合成后 ASR 回读；CosyVoice 与 VoxCPM 推理通过各自专属 worker 隔离版本冲突，不写入素材库
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import re
import queue
import shutil
import subprocess
import sys
import threading
import time
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

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
DEFAULT_PROMPT_AUDIO = "asset/zero_shot_prompt.wav"
DEFAULT_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"
VOXCPM_MODELS = ["voxcpm2", "voxcpm1.5", "voxcpm-0.5b"]
VOXCPM_HF_REPOS = {
    "voxcpm2": "openbmb/VoxCPM2",
    "voxcpm1.5": "openbmb/VoxCPM1.5",
    "voxcpm-0.5b": "openbmb/VoxCPM-0.5B",
}
VOXCPM_MS_REPOS = {
    "voxcpm2": "OpenBMB/VoxCPM2",
    "voxcpm1.5": "OpenBMB/VoxCPM1.5",
    "voxcpm-0.5b": "OpenBMB/VoxCPM-0.5B",
}
# 各版本权重体积（HF 实测近似，用于下载前与 UI 提示）；实际大小以下载时为准。
VOXCPM_META = {
    "voxcpm2": {"label": "VoxCPM2", "params": "2B", "sampleRate": 48000, "languages": 30, "sizeGb": 5.0},
    "voxcpm1.5": {"label": "VoxCPM1.5", "params": "0.8B", "sampleRate": 44100, "languages": 2, "sizeGb": 2.0},
    "voxcpm-0.5b": {"label": "VoxCPM-0.5B", "params": "0.5B", "sampleRate": 16000, "languages": 2, "sizeGb": 1.6},
}
# CosyVoice（含 vendored Matcha-TTS）在模型加载期 import 的第三方包；由 bootstrap 安装进 venv。
# CosyVoice2 的声纹条件并不受益于整段录音。短、连续且可转写的语音片段
# 比长录音更稳定，也不会让短文案落入模型的长度失衡区间。
MAX_REFERENCE_SCAN_SECONDS = 60.0
MIN_REFERENCE_SECONDS = 3.0
TARGET_REFERENCE_SECONDS = 6.0
MIN_REFERENCE_QUALITY_SCORE = 0.75
MIN_TEXT_FIDELITY = 0.85
DEFAULT_VERIFICATION_MODEL = "qwen3-asr-0.6b"
STYLES = {
    "neutral": "",
    "calm": "平静",
    "excited": "兴奋",
    "gentle": "温柔",
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


def run_with_heartbeat(label: str, action):
    """Make long model loading and inference visibly alive without changing their work."""
    started = time.monotonic()
    stopped = threading.Event()

    def pulse() -> None:
        while not stopped.wait(8):
            elapsed = int(time.monotonic() - started)
            print(f"[audio] {label}仍在进行（已等待 {elapsed}s）。", flush=True)

    print(f"[audio] {label}。", flush=True)
    heartbeat = threading.Thread(target=pulse, daemon=True)
    heartbeat.start()
    completed = False
    try:
        result = action()
        completed = True
        return result
    finally:
        stopped.set()
        heartbeat.join(timeout=0.1)
        elapsed = int(time.monotonic() - started)
        outcome = "完成" if completed else "已中止"
        print(f"[audio] {label}{outcome}（耗时 {elapsed}s）。", flush=True)


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


def cosyvoice_python() -> Path:
    value = os.environ.get("RECUT_VENV", "")
    if not value:
        return Path("/nonexistent/recut-cosyvoice-python")
    root = Path(value)
    return root.with_name(f"{root.name}-cosyvoice") / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def cosyvoice_runner() -> Path:
    return Path(__file__).with_name("tts_runner.py")


def parse_worker_result(lines: list[str], return_code: int) -> dict:
    payloads = [line.strip() for line in lines if line.strip().startswith("{")]
    if not payloads:
        detail = "".join(lines).strip()
        raise RuntimeError(detail or "CosyVoice worker did not return a result.")
    payload = json.loads(payloads[-1])
    if return_code or not payload.get("ready"):
        raise RuntimeError(str(payload.get("error") or "CosyVoice worker failed."))
    return payload


def run_worker_process(cmd: list[str], task: str) -> dict:
    print(f"[audio] {task} worker 已启动。", flush=True)
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    output: list[str] = []
    lines: queue.Queue[str | None] = queue.Queue()

    def relay() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=relay, daemon=True).start()
    started = time.monotonic()
    closed = False
    while not closed:
        try:
            line = lines.get(timeout=8)
        except queue.Empty:
            elapsed = int(time.monotonic() - started)
            print(f"[audio] {task}仍在进行（已等待 {elapsed}s，模型正在计算）。", flush=True)
            continue
        if line is None:
            closed = True
            continue
        output.append(line)
        if not line.lstrip().startswith("{"):
            print(line.rstrip(), flush=True)
    return_code = process.wait()
    elapsed = int(time.monotonic() - started)
    print(f"[audio] {task} worker 已结束（耗时 {elapsed}s）。", flush=True)
    return parse_worker_result(output, return_code)


def run_cosyvoice_worker(args: list[str]) -> dict:
    python = cosyvoice_python()
    if not python.is_file():
        raise RuntimeError("CosyVoice 专属运行环境未就绪，请重新准备声音工坊运行环境。")
    task = "正在提取 CosyVoice 声纹" if args[0] == "speaker" else "正在由 CosyVoice 合成语音"
    return run_worker_process([str(python), str(cosyvoice_runner()), *args], task)


def cosyvoice_runtime_status() -> dict:
    python = cosyvoice_python()
    if not python.is_file():
        return {"ready": False, "error": "CosyVoice 专属运行环境未就绪。"}
    result = subprocess.run([str(python), str(cosyvoice_runner()), "status"], capture_output=True, text=True)
    try:
        payload = parse_worker_result(result.stdout.splitlines(keepends=True) + result.stderr.splitlines(keepends=True), result.returncode)
    except RuntimeError as error:
        return {"ready": False, "error": str(error)}
    return {"ready": True, "versions": payload.get("versions", {})}


def voxcpm_python() -> Path:
    value = os.environ.get("RECUT_VENV", "")
    if not value:
        return Path("/nonexistent/recut-voxcpm-python")
    root = Path(value)
    return root.with_name(f"{root.name}-voxcpm") / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def voxcpm_runner() -> Path:
    return Path(__file__).with_name("voxcpm_runner.py")


def voxcpm_model(version: str) -> Path:
    return model_root() / "voxcpm" / version


def downloaded_voxcpm(version: str) -> bool:
    path = voxcpm_model(version)
    return (path / "config.json").is_file() and bool(list(path.glob("*.safetensors")) + list(path.glob("*.bin")))


def ensure_voxcpm_runtime() -> None:
    bootstrap = Path(__file__).resolve().parent.parent / "bootstrap.py"
    print("[audio] 正在准备 VoxCPM 专属运行环境（独立 venv，首次安装较慢）。", flush=True)
    subprocess.run([sys.executable, str(bootstrap), "--voxcpm-only"], check=True)


def download_voxcpm(version: str, source: str) -> None:
    target = voxcpm_model(version)
    meta = VOXCPM_META[version]
    print(f"[audio] 正在下载 {meta['label']} 权重（约 {meta['sizeGb']} GB）。", flush=True)
    if source == "huggingface":
        download_huggingface_repo(VOXCPM_HF_REPOS[version], target)
    elif source == "modelscope":
        download_modelscope_repo(VOXCPM_MS_REPOS[version], target)
    else:
        try:
            print("[audio] 自动下载：先尝试 Hugging Face。", flush=True)
            download_huggingface_repo(VOXCPM_HF_REPOS[version], target)
        except Exception as error:
            print(f"[audio] Hugging Face 不可用（{error}），改用 ModelScope。", flush=True)
            download_modelscope_repo(VOXCPM_MS_REPOS[version], target)
    print(f"[audio] {meta['label']} 权重已就绪。", flush=True)


def voxcpm_runtime_status() -> dict:
    python = voxcpm_python()
    if not python.is_file():
        return {"ready": False, "error": "VoxCPM 专属运行环境未就绪。"}
    result = subprocess.run([str(python), str(voxcpm_runner()), "status"], capture_output=True, text=True)
    try:
        payload = parse_worker_result(result.stdout.splitlines(keepends=True) + result.stderr.splitlines(keepends=True), result.returncode)
    except RuntimeError as error:
        return {"ready": False, "error": str(error)}
    return {"ready": True, "versions": payload.get("versions", {})}


def run_voxcpm_worker(args: list[str]) -> dict:
    python = voxcpm_python()
    if not python.is_file():
        raise RuntimeError("VoxCPM 专属运行环境未就绪，请在配音步骤安装 VoxCPM 运行环境。")
    return run_worker_process([str(python), str(voxcpm_runner()), *args], "正在由 VoxCPM 合成语音")


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
    tts_runtime = cosyvoice_runtime_status()
    if not repository_ready:
        problems.append("CosyVoice 官方仓库或 Matcha-TTS 子模块尚未准备。")
    elif model_ready and not tts_runtime["ready"]:
        problems.append(tts_runtime["error"])
    voxcpm_runtime = voxcpm_runtime_status()
    voxcpm_models = {}
    for version in VOXCPM_MODELS:
        meta = VOXCPM_META[version]
        downloaded = downloaded_voxcpm(version)
        voxcpm_models[version] = {
            "label": meta["label"],
            "params": meta["params"],
            "sampleRate": meta["sampleRate"],
            "languages": meta["languages"],
            "sizeGb": meta["sizeGb"],
            "downloaded": downloaded,
            "ready": downloaded and voxcpm_runtime["ready"],
        }
    engines = {
        "cosyvoice2": {"repository": repository_ready, "model": model_ready, "runtime": tts_runtime["ready"], "ready": repository_ready and model_ready and tts_runtime["ready"]},
        "voxcpm": {
            "runtime": voxcpm_runtime["ready"],
            "runtimeError": None if voxcpm_runtime["ready"] else voxcpm_runtime.get("error"),
            "models": voxcpm_models,
            "ready": voxcpm_runtime["ready"] and any(voxcpm_models[version]["downloaded"] for version in VOXCPM_MODELS),
        },
    }
    return {
        "ready": not problems,
        "modelsRoot": str(root),
        "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
        "asr": {"installed": installed, "qwenRuntime": qwen_runtime_ready},
        "tts": {"repository": repository_ready, "model": model_ready, "runtime": tts_runtime["ready"], "verification": DEFAULT_VERIFICATION_MODEL in installed, "versions": tts_runtime.get("versions", {}), "ready": repository_ready and model_ready and tts_runtime["ready"] and DEFAULT_VERIFICATION_MODEL in installed, "engines": engines},
        "error": " ".join(problems),
    }


def extract_audio(source: Path, target: Path) -> None:
    command = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(target)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"Could not extract audio: {result.stderr.strip()}")


def run_ffmpeg(command: list[str], failure: str) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{failure}: {result.stderr.strip()}")
    return f"{result.stdout}\n{result.stderr}"


def preprocess_reference_audio(source: Path, target: Path) -> None:
    """Create one predictable 16k mono analysis track without changing speech timing."""
    run_ffmpeg(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-vn", "-t", str(MAX_REFERENCE_SCAN_SECONDS), "-af", "highpass=f=80,lowpass=f=7600", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(target)],
        "Could not prepare reference audio",
    )


def silence_boundaries(audio: Path) -> list[tuple[float, float]]:
    logs = run_ffmpeg(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(audio), "-af", "silencedetect=noise=-38dB:d=0.32", "-f", "null", "-"],
        "Could not analyze reference audio",
    )
    events: list[tuple[str, float]] = []
    for kind, value in re.findall(r"silence_(start|end):\s*([0-9.]+)", logs):
        events.append((kind, float(value)))
    duration = probe_duration(audio)
    speech: list[tuple[float, float]] = []
    cursor = 0.0
    for kind, value in events:
        if kind != "start":
            cursor = value
            continue
        if value > cursor:
            speech.append((cursor, value))
        cursor = value
    if duration > cursor:
        speech.append((cursor, duration))
    return [(start, end) for start, end in speech if end - start >= 0.2]


def select_best_speech_segment(audio: Path) -> tuple[float, float]:
    """Prefer one uninterrupted six-second speech span over a long, mixed recording."""
    candidates = silence_boundaries(audio)
    if not candidates:
        raise RuntimeError("参考音频没有检测到可用语音。")
    start, end = max(candidates, key=lambda item: item[1] - item[0])
    duration = end - start
    if duration < MIN_REFERENCE_SECONDS:
        raise RuntimeError(f"参考音频缺少至少 {MIN_REFERENCE_SECONDS:.0f} 秒连续人声，请换一段更清晰的语音。")
    selected = min(TARGET_REFERENCE_SECONDS, duration)
    # Long uninterrupted speech is equally useful throughout. Centering avoids
    # capture clicks and the natural inhale/exhale commonly found at the edges.
    offset = max(0.0, (duration - selected) / 2)
    return start + offset, selected


def cut_reference_audio(source: Path, target: Path, start: float, duration: float) -> None:
    run_ffmpeg(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(source), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(target)],
        "Could not extract the selected speech segment",
    )


def waveform_metrics(audio: Path) -> dict[str, float]:
    import soundfile as sf

    samples, sample_rate = sf.read(str(audio), dtype="float32", always_2d=False)
    waveform = np.asarray(samples, dtype=np.float32).reshape(-1)
    if sample_rate != 16000 or not waveform.size or not np.isfinite(waveform).all():
        raise RuntimeError("参考音频不是有效的 16k 单声道波形。")
    peak = float(np.max(np.abs(waveform)))
    rms = float(np.sqrt(np.mean(np.square(waveform))))
    return {
        "duration": float(waveform.size / sample_rate),
        "peak": peak,
        "rmsDb": 20 * math.log10(max(rms, 1e-8)),
        "voicedRatio": float(np.mean(np.abs(waveform) >= 0.012)),
        "clippingRatio": float(np.mean(np.abs(waveform) >= 0.995)),
    }


def normalize_reference_audio(audio: Path) -> None:
    import soundfile as sf

    samples, sample_rate = sf.read(str(audio), dtype="float32", always_2d=False)
    waveform = np.asarray(samples, dtype=np.float32).reshape(-1)
    peak = float(np.max(np.abs(waveform)))
    if peak > 0:
        waveform *= min(1.0, 0.89 / peak)
    sf.write(str(audio), waveform, sample_rate, format="WAV", subtype="PCM_16")


def assess_reference_audio(audio: Path) -> dict:
    metrics = waveform_metrics(audio)
    level_score = max(0.0, 1.0 - abs(metrics["rmsDb"] + 20.0) / 28.0)
    score = 0.35 * min(1.0, metrics["duration"] / MIN_REFERENCE_SECONDS) + 0.35 * min(1.0, metrics["voicedRatio"] / 0.65) + 0.2 * level_score + 0.1 * max(0.0, 1.0 - metrics["clippingRatio"] * 50.0)
    quality = {**metrics, "score": round(score, 3), "passed": score >= MIN_REFERENCE_QUALITY_SCORE}
    if not quality["passed"]:
        raise RuntimeError(f"参考音频质量未达标（{quality['score']:.2f}/{MIN_REFERENCE_QUALITY_SCORE:.2f}）：需要清晰、连续且不过曝的人声。")
    return quality


def build_speaker_embedding(prompt_wav: Path) -> dict[str, float | int]:
    """Validate a role in the same official runtime that will synthesize it."""
    return run_cosyvoice_worker(["speaker", "--model-dir", str(cosyvoice_model()), "--reference", str(prompt_wav)])


def normalized_text(value: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]", "", value).lower()


def text_similarity(expected: str, actual: str) -> float:
    """Bidirectional character similarity rejects both omissions and garbage insertions."""
    target = normalized_text(expected)
    observed = normalized_text(actual)
    if not target or not observed:
        return 0.0
    return SequenceMatcher(None, target, observed).ratio()


def transcribe_for_quality(model_id: str, audio: Path) -> str:
    entries, _, _, _ = transcribe_whisper(model_id, audio, "auto") if model_id in WHISPER_MODELS else transcribe_qwen(model_id, audio, "auto")
    return "".join(entry["text"] for entry in entries)


def verify_spoken_text(model_id: str, audio: Path, expected: str, stage: str) -> dict[str, float | str]:
    print(f"[audio] {stage}：准备回读 {len(normalized_text(expected))} 个有效字符。", flush=True)
    actual = transcribe_for_quality(model_id, audio)
    fidelity = text_similarity(expected, actual)
    print(f"[audio] {stage}：回读完成，保真度 {fidelity:.2f}。", flush=True)
    if fidelity < MIN_TEXT_FIDELITY:
        raise RuntimeError(f"{stage} 文本回读未通过（{fidelity:.2f}/{MIN_TEXT_FIDELITY:.2f}），未交付该声音结果。")
    return {"fidelity": round(fidelity, 3), "transcript": actual}


def probe_duration(path: Path) -> float:
    result = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", f"{result.stdout}\n{result.stderr}")
    if not match:
        return 0.0
    try:
        hours, minutes, seconds = match.groups()
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
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
    elif selected in VOXCPM_MODELS:
        ensure_voxcpm_runtime()
        download_voxcpm(selected, source)
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
    qwen = run_with_heartbeat(f"正在加载 {model_id} 模型", lambda: load_qwen(model_id))
    results = run_with_heartbeat(f"{model_id} 正在识别 {duration:.1f} 秒音频", lambda: qwen.transcribe(audio=str(audio), language=QWEN_LANGUAGE_MAP[language], return_time_stamps=True))
    if not results:
        raise RuntimeError("Qwen 未返回转写结果。")
    result = results[0]
    try:
        entries = qwen_segments(getattr(result, "time_stamps", None), duration)
    except RuntimeError:
        # Qwen 离线时间戳对齐器对无内容/近静音音频常返回空。若已装 Whisper，
        # 回退用 Whisper 的 VAD + 真实时间戳，保证任务仍产出可读字幕。
        for fallback in WHISPER_MODELS:
            if not downloaded_whisper(fallback):
                continue
            print(f"[audio] {model_id} 时间戳对齐失败（{duration:.1f}s），回退 {fallback} 生成带时间戳转写。", flush=True)
            return transcribe_whisper(fallback, audio, language)
        raise
    for entry in entries:
        print(f"[audio] {format_timecode(entry['start'])} → {format_timecode(entry['end'])}：{entry['text']}", flush=True)
    return entries, str(getattr(result, "language", "")), 1.0, duration


def transcribe(model_id: str, language: str, source_relative: str, stem_relative: str) -> None:
    current = state(model_root())
    if model_id not in ASR_MODELS or model_id not in current["asr"]["installed"]:
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
    if model_id not in ASR_MODELS or model_id not in current["asr"]["installed"] or not current["tts"]["ready"]:
        emit({"ready": False, "error": current["error"] or f"Model {model_id} has not been installed."}, 1)
    source = safe_file(source_relative)
    stem = safe_file(stem_relative)
    stem.parent.mkdir(parents=True, exist_ok=True)
    wav = stem.with_suffix(".wav")
    prepared = stem.with_name(stem.name + ".prepared.wav")
    try:
        print("[audio] 正在预处理参考音频。", flush=True)
        preprocess_reference_audio(source, prepared)
        start, duration = select_best_speech_segment(prepared)
        print(f"[audio] 已选取 {duration:.1f} 秒连续人声作为角色样本。", flush=True)
        cut_reference_audio(prepared, wav, start, duration)
    finally:
        prepared.unlink(missing_ok=True)
    normalize_reference_audio(wav)
    quality = assess_reference_audio(wav)
    print(f"[audio] 参考音质已通过（评分 {quality['score']:.2f}）。", flush=True)
    print("[audio] 正在验证 CosyVoice 声纹。", flush=True)
    speaker = build_speaker_embedding(wav)
    print(f"[audio] 声纹已通过（{speaker['dimensions']} 维）。", flush=True)
    print(f"[audio] 正在用 {model_id} 转写已选角色样本，生成零样本提示词。", flush=True)
    entries, detected_language, _, _ = transcribe_whisper(model_id, wav, "auto") if model_id in WHISPER_MODELS else transcribe_qwen(model_id, wav, "auto")
    prompt_text = "".join(entry["text"] for entry in entries)
    if len(prompt_text) < 4:
        raise RuntimeError("角色样本的转写内容过短，无法建立可靠的声音角色。")
    calibration = wav.with_name("calibration.wav")
    try:
        print("[audio] 正在校准声音角色朗读质量。", flush=True)
        run_cosyvoice_worker(["synthesize", "--model-dir", str(cosyvoice_model()), "--reference", str(wav), "--prompt-text", prompt_text, "--text", prompt_text, "--output", str(calibration)])
        calibration_result = verify_spoken_text(model_id, calibration, prompt_text, "声音角色校准")
    finally:
        calibration.unlink(missing_ok=True)
    meta = {"wav": str(wav.relative_to(files_root())), "promptText": prompt_text, "duration": round(duration, 3), "language": detected_language, "quality": quality, "speaker": speaker, "calibration": calibration_result}
    Path(str(wav) + ".meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[audio] 角色参考音已就绪（{duration:.1f}s）。", flush=True)
    emit({"ready": True, **meta})


def synthesize_voxcpm(engine: str, current: dict, text: str, reference_relative: str, prompt_text: str, default_voice: bool, output: Path) -> dict:
    voxcpm = current["tts"]["engines"]["voxcpm"]
    if not voxcpm["runtime"]:
        raise RuntimeError(f"VoxCPM 运行环境未就绪：{voxcpm.get('runtimeError') or '请先在配音步骤安装 VoxCPM 运行环境。'}")
    meta = VOXCPM_META[engine]
    if not voxcpm["models"][engine]["downloaded"]:
        raise RuntimeError(f"{meta['label']} 权重尚未下载，请先在配音步骤下载（约 {meta['sizeGb']} GB）。")
    is_v2 = engine == "voxcpm2"
    args = ["synthesize", "--version", engine, "--model-dir", str(voxcpm_model(engine)), "--text", text, "--output", str(output)]
    if default_voice:
        if not is_v2:
            raise RuntimeError("VoxCPM1.5 / VoxCPM-0.5B 使用延续式克隆，没有默认音，请选择一个声音角色。")
        args.append("--voice-design")
    else:
        reference = safe_file(reference_relative)
        if not reference.is_file():
            raise RuntimeError("声音角色参考音不可用。")
        args += ["--reference", str(reference)]
        if not is_v2:
            args += ["--prompt-text", prompt_text]
    print(f"[audio] 正在启动 VoxCPM（{meta['label']}）专属 worker（首次加载较慢）。", flush=True)
    return run_voxcpm_worker(args)


def synthesize(text: str, reference_relative: str, prompt_text: str, style: str, output_relative: str, default_voice: bool = False, engine: str = "cosyvoice2") -> None:
    current = state(model_root())
    if DEFAULT_VERIFICATION_MODEL not in current["asr"]["installed"]:
        emit({"ready": False, "error": "缺少 Qwen3-ASR 0.6B，无法执行合成后文本回读验收。"}, 1)
    output = safe_file(output_relative)
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        if engine in VOXCPM_MODELS:
            rendered = synthesize_voxcpm(engine, current, text, reference_relative, prompt_text, default_voice, output)
            print(f"[audio] 使用{VOXCPM_META[engine]['label']}：{'Voice Design 默认音' if default_voice else '经验证声音角色'}。", flush=True)
        else:
            if not current["tts"]["ready"]:
                emit({"ready": False, "error": current["error"] or "CosyVoice 运行环境未就绪。"}, 1)
            repository = cosyvoice_repo()
            model_dir = cosyvoice_model()
            if not current["tts"]["ready"]:
                emit({"ready": False, "error": "CosyVoice 运行环境未就绪：请先安装官方仓库（含 Matcha-TTS 子模块）并下载 CosyVoice2-0.5B 权重。"}, 1)
            reference = repository / DEFAULT_PROMPT_AUDIO if default_voice else safe_file(reference_relative)
            prompt_text = DEFAULT_PROMPT_TEXT if default_voice else prompt_text
            if not reference.is_file() or not prompt_text:
                raise RuntimeError("声音角色参考音或提示词不可用。")
            print("[audio] 正在启动 CosyVoice2 专属 worker（首次加载较慢）。", flush=True)
            voice_label = "CosyVoice 官方默认声音" if default_voice else "经验证声音角色"
            print(f"[audio] 使用{voice_label}：{style} 风格。", flush=True)
            rendered = run_cosyvoice_worker(["synthesize", "--model-dir", str(model_dir), "--reference", str(reference), "--prompt-text", prompt_text, "--text", text, "--output", str(output)])
        print("[audio] WAV 已生成，开始单次 Qwen3-ASR 回读验收。", flush=True)
        verification = verify_spoken_text(DEFAULT_VERIFICATION_MODEL, output, text, "合成输出")
        meta = {"wav": str(output.relative_to(files_root())), "duration": rendered["duration"], "sampleRate": rendered["sampleRate"], "style": style, "engine": engine, "verification": verification}
        Path(str(output) + ".meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[audio] 合成与回读验收完成：{meta['duration']:.1f} 秒，保真度 {verification['fidelity']:.2f}。", flush=True)
        emit({"ready": True, **meta})
    except Exception as error:
        output.unlink(missing_ok=True)
        Path(str(output) + ".meta.json").unlink(missing_ok=True)
        emit({"ready": False, "error": str(error)}, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    install_parser = commands.add_parser("install")
    install_parser.add_argument("--model", choices=ASR_MODELS + ["cosyvoice2"] + VOXCPM_MODELS, required=True)
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
    synthesize_parser.add_argument("--reference", default="")
    synthesize_parser.add_argument("--prompt-text", default="")
    synthesize_parser.add_argument("--default-voice", action="store_true")
    synthesize_parser.add_argument("--style", choices=list(STYLES), default="neutral")
    synthesize_parser.add_argument("--engine", choices=["cosyvoice2"] + VOXCPM_MODELS, default="cosyvoice2")
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
            synthesize(args.text, args.reference, args.prompt_text, args.style, args.output, args.default_voice, args.engine)
    except SystemExit:
        raise
    except Exception as error:
        emit({"ready": False, "error": str(error)}, 1)


if __name__ == "__main__":
    main()
