#!/usr/bin/env python3
"""
[INPUT]: 读取包内 presets/catalog.json（单一信息源）、RECUT_VENV、RECUT_MODELS_DIR、VoxCPM2 权重
[OUTPUT]: 在 publish/presets/<version>/ 生成探针 WAV 与 CDN manifest.json（sha256/license/promptText/保真度）；
          --sync 时再生成 background.js 兜底清单块并暂存 cdn/buckets/voices/
[POS]: voice-presets-and-voice-design RFC 的官方发布管线；在主 ASR venv 内运行（需要 Qwen3-ASR 回读），经 voxcpm venv worker 合成
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import audio_runner  # noqa: E402

APP_ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = APP_ROOT / "presets" / "catalog.json"
CDN_BUCKET = Path(__file__).resolve().parent.parent.parent.parent / "cdn" / "buckets" / "voices"
BACKGROUND_PATH = APP_ROOT / "background.js"
# background.js 兜底清单块的首尾标记（--sync 时整块重生成；单一信息源仍是 presets/catalog.json）。
BACKGROUND_FALLBACK_BEGIN = "// [preset-fallback:generated] 以下块由 python/publish_presets.py --sync 从 presets/catalog.json 再生成，勿手改。"
BACKGROUND_FALLBACK_END = "// [/preset-fallback:generated]"

RFC_VERSION = str(json.loads(CATALOG_PATH.read_text(encoding="utf-8")).get("version") or "v1")
DEFAULT_SEED = 42
READBACK_MODEL = "qwen3-asr-0.6b"
FIDELITY_THRESHOLD = 0.85
# 方言预设：听感优先，回读保真度只记录不阻断（RFC §3 注）。
DIALECT_PRESETS = {"dongbei", "yueyu-nan", "sichuan-nv"}

_CATALOG = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
PRESETS: list[dict] = list(_CATALOG["presets"])
PROBE_TEXT: str = str(_CATALOG["probeText"])
LICENSE: str = str(_CATALOG["license"])


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def synthesize_probe(preset: dict, wav: Path) -> None:
    result = audio_runner.run_voxcpm_worker([
        "synthesize",
        "--version", "voxcpm2",
        "--model-dir", str(audio_runner.voxcpm_model("voxcpm2")),
        "--voice-design",
        "--design-desc", preset["designDesc"],
        "--seed", str(DEFAULT_SEED),
        "--text", PROBE_TEXT,
        "--output", str(wav),
    ])
    if not result.get("ready"):
        raise RuntimeError(f"{preset['id']}: {result.get('error', '未知合成错误')}")


def main() -> None:
    dist = Path(__file__).resolve().parent.parent / "publish" / "presets" / RFC_VERSION
    dist.mkdir(parents=True, exist_ok=True)
    entries = []
    failures = []
    for index, preset in enumerate(PRESETS, 1):
        pid = preset["id"]
        wav = dist / f"{pid}.wav"
        record = {
            "id": pid,
            "name": preset["name"],
            "scene": preset["scene"],
            "blurb": preset["blurb"],
            "designDesc": preset["designDesc"],
            "version": RFC_VERSION,
            "promptText": PROBE_TEXT,
            "license": LICENSE,
            "source": {"generator": "voxcpm2", "designDesc": preset["designDesc"], "seed": DEFAULT_SEED},
        }
        if wav.is_file():
            print(f"[publish] ({index}/{len(PRESETS)}) {pid} 已存在，跳过生成。", flush=True)
        else:
            print(f"[publish] ({index}/{len(PRESETS)}) 生成 {pid}…", flush=True)
            try:
                synthesize_probe(preset, wav)
            except RuntimeError as error:
                failures.append({"id": pid, "error": str(error)})
                print(f"[publish] {pid} 生成失败：{error}", flush=True)
                continue
        transcript = audio_runner.transcribe_for_quality(READBACK_MODEL, wav)
        fidelity = round(audio_runner.text_similarity(PROBE_TEXT, transcript), 4)
        blocked = fidelity < FIDELITY_THRESHOLD and pid not in DIALECT_PRESETS
        if blocked:
            wav.unlink(missing_ok=True)
            failures.append({"id": pid, "error": f"回读保真度 {fidelity} < {FIDELITY_THRESHOLD}"})
            print(f"[publish] {pid} 回读未达标（{fidelity}），已删除待重跑。", flush=True)
            continue
        record.update({
            "url": f"./{pid}.wav",
            "sha256": sha256_of(wav),
            "bytes": wav.stat().st_size,
            "readback": {"model": READBACK_MODEL, "fidelity": fidelity, "transcript": transcript, "blocked": False},
        })
        entries.append(record)
        print(f"[publish] {pid} 完成，保真度 {fidelity}。", flush=True)
    manifest = {"version": RFC_VERSION, "probeText": PROBE_TEXT, "license": LICENSE, "presets": entries}
    (dist / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (dist / "failures.json").write_text(json.dumps(failures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[publish] manifest 写入 {dist / 'manifest.json'}；成功 {len(entries)}，失败 {len(failures)}。", flush=True)


def sync_background_fallback() -> None:
    """把 presets/catalog.json 的 id/双语名/场景再生成进 background.js 标记块（运行时兜底用）。"""
    lines = [BACKGROUND_FALLBACK_BEGIN, "const PRESET_BOOTSTRAP_FALLBACK = ["]
    for preset in PRESETS:
        lines.append("  " + json.dumps(
            {"id": preset["id"], "name": preset["name"], "scene": preset["scene"]},
            ensure_ascii=False,
        ) + ",")
    lines.append("];")
    lines.append(BACKGROUND_FALLBACK_END)
    block = "\n".join(lines)
    source = BACKGROUND_PATH.read_text(encoding="utf-8")
    pattern = re.compile(re.escape(BACKGROUND_FALLBACK_BEGIN) + r".*?" + re.escape(BACKGROUND_FALLBACK_END), re.DOTALL)
    if pattern.search(source):
        source = pattern.sub(lambda _: block, source)
    else:
        # 首次接入：替换旧的整段常量定义（无标记的历史版本）。
        legacy = re.compile(r"// 离线 / Python 环境未就绪时 audio\.presets 的 JS 兜底清单.*?\n\];\n", re.DOTALL)
        if not legacy.search(source):
            raise SystemExit("[sync] background.js 中既无标记块也无旧兜底清单，请人工接入。")
        source = legacy.sub(block + "\n", source)
    BACKGROUND_PATH.write_text(source, encoding="utf-8")
    print(f"[sync] background.js 兜底清单已再生成（{len(PRESETS)} 条）。", flush=True)


def stage_cdn(dist: Path) -> Path:
    """把发布产物暂存到 cdn/buckets/voices/（版本目录 + manifest.json 版本指针），供 make voices-upload 上传 R2。"""
    CDN_BUCKET.mkdir(parents=True, exist_ok=True)
    target = CDN_BUCKET / RFC_VERSION
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(dist, target)
    (CDN_BUCKET / "manifest.json").write_text(
        json.dumps({"version": RFC_VERSION, "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[sync] CDN 暂存完成：{CDN_BUCKET}（版本 {RFC_VERSION}），执行 make voices-upload 上传。", flush=True)
    return target


def sync() -> None:
    dist = Path(__file__).resolve().parent.parent / "publish" / "presets" / RFC_VERSION
    if not (dist / "manifest.json").is_file():
        raise SystemExit(f"[sync] 未找到 {dist / 'manifest.json'}，请先运行发布生成。")
    sync_background_fallback()
    stage_cdn(dist)


if __name__ == "__main__":
    if "--sync" in sys.argv:
        sync()
    else:
        main()
