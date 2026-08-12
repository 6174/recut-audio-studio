"""
[INPUT]: 平台注入的 RECUT_MODELS_DIR、RECUT_PYTHON、RECUT_VENV 与标准库 HTTPS/ZIP/子进程能力
[OUTPUT]: 在共享模型目录准备 CosyVoice 与 Matcha-TTS 官方代码，并创建与 Qwen3-ASR 隔离的官方 TTS venv
[POS]: audio-studio 的跨平台代码与 TTS 运行时准备器；主 venv 只保留 ASR，避免 transformers 依赖互相覆盖
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import os
import json
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

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


def main() -> None:
    root = Path(os.environ["RECUT_MODELS_DIR"]) / "audio-studio" / "cosyvoice"
    repository = root / "repository"
    if not (repository / "cosyvoice" / "cli" / "frontend.py").is_file() or not has_revision(repository, COSYVOICE_REVISION):
        install_archive(f"https://github.com/FunAudioLLM/CosyVoice/archive/{COSYVOICE_REVISION}.zip", repository, "CosyVoice", COSYVOICE_REVISION)
    matcha = repository / "third_party" / "Matcha-TTS"
    if not (matcha / "matcha").is_dir() or not has_revision(matcha, MATCHA_REVISION):
        install_archive(f"https://github.com/shivammehta25/Matcha-TTS/archive/{MATCHA_REVISION}.zip", matcha, "Matcha-TTS", MATCHA_REVISION)
    install_tts_runtime()
    print("[audio] CosyVoice 官方代码与专属运行环境已就绪。", flush=True)


if __name__ == "__main__":
    main()
