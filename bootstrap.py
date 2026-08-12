"""
[INPUT]: 平台注入的 RECUT_MODELS_DIR 与标准库 HTTPS/ZIP 能力
[OUTPUT]: 在共享模型目录准备 CosyVoice 和 Matcha-TTS 官方代码
[POS]: audio-studio 的跨平台代码准备兜底；不创建 venv、不安装 pip 依赖
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path


def install_archive(url: str, target: Path, label: str) -> None:
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


def main() -> None:
    root = Path(os.environ["RECUT_MODELS_DIR"]) / "audio-studio" / "cosyvoice"
    repository = root / "repository"
    if not (repository / "cosyvoice" / "cli" / "frontend.py").is_file():
        install_archive("https://github.com/FunAudioLLM/CosyVoice/archive/refs/heads/main.zip", repository, "CosyVoice")
    matcha = repository / "third_party" / "Matcha-TTS"
    if not (matcha / "matcha").is_dir():
        install_archive("https://github.com/shivammehta25/Matcha-TTS/archive/refs/heads/main.zip", matcha, "Matcha-TTS")
    print("[audio] CosyVoice 官方代码已就绪。", flush=True)


if __name__ == "__main__":
    main()
