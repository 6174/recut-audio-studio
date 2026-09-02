"""
[INPUT]: 平台注入的 RECUT_MODELS_DIR、RECUT_PYTHON、RECUT_VENV 与标准库 HTTPS/ZIP/子进程能力；--target 定向准备（all/cosyvoice/voxcpm）与 --task-log 任务日志文件
[OUTPUT]: 在共享模型目录准备 CosyVoice 与 Matcha-TTS 官方代码，并创建与 Qwen3-ASR 隔离的官方 TTS venv；按 target 定向准备 CosyVoice / VoxCPM 专属 venv（全量模式尽力创建 VoxCPM venv）
[POS]: audio-studio 的跨平台代码与 TTS 运行时准备器；主 venv 只保留 ASR，CosyVoice/VoxCPM 各自独立 venv，避免 transformers/torch 依赖互相覆盖
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import argparse
import builtins
import datetime
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

# 任务日志 tee（与 audio_runner 同契约）：把 [audio] 进度行以 JSON-lines 追加到 --task-log 文件，
# 供任务中心在任务结束后回看；模块级定义保证可被子进程 pickle 安全引用。
_ORIG_PRINT = builtins.print
_TASK_LOG = None


def _write_task_log(text: str) -> None:
    if _TASK_LOG is None:
        return
    line = text.strip()
    if not line:
        return
    msg = line[len("[audio] "):] if line.startswith("[audio] ") else line
    level = "info"
    if any(word in msg for word in ("失败", "错误", "不可用", "异常")):
        level = "error"
    elif any(word in msg for word in ("完成", "就绪", "已下载", "成功")):
        level = "ok"
    elif any(word in msg for word in ("较慢", "回退", "等待", "重试", "进行")):
        level = "warn"
    _TASK_LOG.write(json.dumps({"ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "level": level, "message": msg}, ensure_ascii=False) + "\n")
    _TASK_LOG.flush()


def _teed_print(*args, **kwargs):
    _ORIG_PRINT(*args, **kwargs)
    if args:
        _write_task_log(str(args[0]))


def resolve_task_log(raw: str) -> None:
    """解析 --task-log（相对路径以 App 文件区为根），打开追加句柄并接管 print。"""
    global _TASK_LOG
    if not raw:
        return
    candidate = Path(raw)
    if not candidate.is_absolute() and os.environ.get("RECUT_APP_FILES_DIR"):
        candidate = Path(os.environ["RECUT_APP_FILES_DIR"]) / candidate
    candidate.parent.mkdir(parents=True, exist_ok=True)
    _TASK_LOG = open(candidate, "a", encoding="utf-8")
    builtins.print = _teed_print

COSYVOICE_REVISION = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
MATCHA_REVISION = "dd9105b34bf2be2230f4aa1e4769fb586a3c824e"

def revision_file(target: Path) -> Path:
    return target / ".recut-revision.json"


def has_revision(target: Path, revision: str) -> bool:
    try:
        return json.loads(revision_file(target).read_text(encoding="utf-8"))["revision"] == revision
    except (FileNotFoundError, ValueError, KeyError):
        result = subprocess.run(["git", "-C", str(target), "rev-parse", "HEAD"], capture_output=True, text=True)
        return result.returncode == 0 and result.stdout.strip() == revision


def install_archive(url: str, target: Path, label: str, revision: str) -> None:
    with tempfile.TemporaryDirectory(prefix="recut-audio-bootstrap-") as raw:
        temporary = Path(raw)
        archive = temporary / "source.zip"
        print(f"[audio] 正在下载 {label} 官方代码。", flush=True)
        urllib.request.urlretrieve(url, archive)
        with zipfile.ZipFile(archive) as bundle:
            roots = {name.split("/", 1)[0] for name in bundle.namelist() if "/" in name}
            if len(roots) != 1:
                raise RuntimeError(f"{label} 官方代码归档结构无效")
            bundle.extractall(temporary)
        source = temporary / roots.pop()
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(target, ignore_errors=True)
        shutil.move(str(source), target)
        revision_file(target).write_text(json.dumps({"revision": revision}), encoding="utf-8")


def cosyvoice_venv() -> Path:
    root = Path(os.environ["RECUT_VENV"])
    return root.with_name(f"{root.name}-cosyvoice")


def cosyvoice_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def install_cosyvoice_code() -> None:
    """幂等安装 CosyVoice 官方代码与 Matcha-TTS 子模块（固定 commit 归档）。"""
    root = Path(os.environ["RECUT_MODELS_DIR"]) / "audio-studio" / "cosyvoice"
    repository = root / "repository"
    if not (repository / "cosyvoice" / "cli" / "frontend.py").is_file() or not has_revision(repository, COSYVOICE_REVISION):
        install_archive(f"https://github.com/FunAudioLLM/CosyVoice/archive/{COSYVOICE_REVISION}.zip", repository, "CosyVoice", COSYVOICE_REVISION)
    matcha = repository / "third_party" / "Matcha-TTS"
    if not (matcha / "matcha").is_dir() or not has_revision(matcha, MATCHA_REVISION):
        install_archive(f"https://github.com/shivammehta25/Matcha-TTS/archive/{MATCHA_REVISION}.zip", matcha, "Matcha-TTS", MATCHA_REVISION)


def install_tts_runtime() -> None:
    python = os.environ.get("RECUT_PYTHON")
    if not python or not os.environ.get("RECUT_VENV"):
        raise RuntimeError("RECUT_PYTHON and RECUT_VENV are required to prepare CosyVoice")
    venv = cosyvoice_venv()
    target = cosyvoice_python(venv)
    if not target.is_file():
        print("[audio] 正在创建 CosyVoice 专属运行环境。", flush=True)
        subprocess.run([python, "-m", "venv", str(venv)], check=True)
    requirements = Path(__file__).resolve().parent / "python" / "cosyvoice.requirements.lock"
    print("[audio] 正在安装 CosyVoice 官方锁定依赖。", flush=True)
    subprocess.run([str(target), "-m", "pip", "install", "--disable-pip-version-check", "--requirement", str(requirements)], check=True)
    print("[audio] 正在验证 CosyVoice 依赖闭包与版本。", flush=True)
    subprocess.run([str(target), "-m", "pip", "check"], check=True)
    subprocess.run([str(target), str(Path(__file__).resolve().parent / "python" / "tts_runner.py"), "status"], check=True)
    print("[audio] CosyVoice 专属运行环境已就绪。", flush=True)


def voxcpm_venv() -> Path:
    root = Path(os.environ["RECUT_VENV"])
    return root.with_name(f"{root.name}-voxcpm")


def voxcpm_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_voxcpm_runtime() -> None:
    """Create the isolated VoxCPM venv and install its managed dependency closure.

    VoxCPM needs Python >=3.10 and torch >=2.5.0, which conflict with the pinned
    ASR venv (transformers 4.57.6) and CosyVoice venv (torch 2.3.1), so it gets its
    own `-voxcpm` venv. Model weights are never downloaded here; that is the
    audio.install step's job.
    """
    python = os.environ.get("RECUT_PYTHON")
    if not python or not os.environ.get("RECUT_VENV"):
        raise RuntimeError("RECUT_PYTHON and RECUT_VENV are required to prepare VoxCPM")
    venv = voxcpm_venv()
    target = voxcpm_python(venv)
    if not target.is_file():
        print("[audio] 正在创建 VoxCPM 专属运行环境（独立 venv，与 CosyVoice/ASR 隔离）。", flush=True)
        subprocess.run([python, "-m", "venv", str(venv)], check=True)
    requirements = Path(__file__).resolve().parent / "python" / "voxcpm.requirements.lock"
    print("[audio] 正在安装 VoxCPM 官方依赖（首次会下载 torch 等较大组件，请耐心等待）。", flush=True)
    subprocess.run([str(target), "-m", "pip", "install", "--disable-pip-version-check", "--requirement", str(requirements)], check=True)
    print("[audio] 正在验证 VoxCPM 依赖闭包与版本。", flush=True)
    subprocess.run([str(target), "-m", "pip", "check"], check=True)
    subprocess.run([str(target), str(Path(__file__).resolve().parent / "python" / "voxcpm_runner.py"), "status"], check=True)
    print("[audio] VoxCPM 专属运行环境已就绪。", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", choices=["all", "cosyvoice", "voxcpm"], default="all", help="定向准备目标：all=全量（缺省） / cosyvoice=官方代码+专属 venv / voxcpm=专属 venv")
    parser.add_argument("--voxcpm-only", action="store_true", help="兼容别名：等价于 --target voxcpm")
    parser.add_argument("--task-log", default="", help="可选：把进度以 JSON-lines 追加到该文件（供任务中心回看）")
    args = parser.parse_args()
    resolve_task_log(args.task_log)
    target = "voxcpm" if args.voxcpm_only else args.target
    if target == "voxcpm":
        ensure_voxcpm_runtime()
        print("[audio] VoxCPM 专属运行环境已就绪。", flush=True)
        return
    install_cosyvoice_code()
    install_tts_runtime()
    print("[audio] CosyVoice 官方代码与专属运行环境已就绪。", flush=True)
    if target != "cosyvoice":
        # VoxCPM 是可选的第二个 TTS 引擎：全量 prepare 中尽力准备，失败不阻断，
        # 由 audio.status 的 engines.voxcpm.runtime 暴露错误，设置面板提供定向安装。
        try:
            ensure_voxcpm_runtime()
        except Exception as error:
            print(f"[audio] 警告：VoxCPM 专属运行环境准备失败（{error}）。", flush=True)
            print("[audio] 不影响转写与 CosyVoice 配音；可在「模型与环境」设置中定向安装 VoxCPM 运行环境。", flush=True)


if __name__ == "__main__":
    main()
