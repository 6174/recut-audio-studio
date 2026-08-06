# python/

> L2 | 父级: /apps/audio-studio/README.md

成员清单
audio_runner.py: 本机 Python 执行入口；检查 FFmpeg 与模型状态，按 Hugging Face、ModelScope 或自动回退下载 Whisper / Qwen3-ASR / CosyVoice2 权重，Qwen 同时安装官方时间戳对齐器；抽取音频轨道并转写为 transcript.json 文稿与 SRT 字幕、把参考音归一化为 16k 单声道 wav 并自动生成角色提示词、用 CosyVoice2 零样本或情绪指令合成配音 wav，各阶段输出实时进度；不管理 venv 或依赖安装。
requirements.lock: 平台 Python runtime 的锁定依赖清单；固定 Qwen 官方 qwen-asr、ModelScope 与 transformers 版本，其内容参与 venv 指纹，变更会得到新的隔离环境。

依赖关系

`background.js -> ctx.python.run -> audio_runner.py`；平台先从 `manifest.runtime.python` 创建/激活 venv，再把 App 文件根、模型根和 `RECUT_VENV` 注入脚本。脚本绝不读取 SQLite、调用 Recut HTTP API 或写入素材库。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
