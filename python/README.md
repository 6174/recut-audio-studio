# python/

> L2 | 父级: /apps/audio-studio/README.md

成员清单
audio_runner.py: 本机工作流入口；下载与转写仍在平台 ASR venv 内执行，VoiceCloneEngine 自动选取 3~6 秒连续人声、验收波形/声纹，并在创建角色及最终合成时使用 ASR 回读守门；只有文本保真度达标的 WAV 可交付。
tts_runner.py: CosyVoice 专属 worker；只加载官方固定版本组合，执行零样本合成与声纹提取，末行输出 JSON，绝不导入 Qwen3-ASR。
requirements.lock: 平台 ASR venv 的完整版本闭包；逐项固定经验证的 Qwen3-ASR 0.0.6、faster-whisper 1.2.1 与所有传递依赖，不承载 CosyVoice。
cosyvoice.requirements.lock: CosyVoice 官方 TTS venv 的完整版本闭包；逐项固定 torch/torchaudio 2.3.1、transformers 4.51.3、numpy 1.26.4 与所有传递依赖，隔离 Qwen 冲突。
whisper_shim.py: CosyVoice worker 的兼容边界；向 sys.modules 注入 vendored 的 whisper / whisper.tokenizer / modelscope 占位，并把 CosyVoice 的 load_wav 替换为 soundfile 实现。

依赖关系

`background.js -> ctx.python.run -> audio_runner.py -> tts_runner.py`；平台先创建 ASR venv 并安装 `requirements.lock`，随后 `bootstrap.py` 在其同级创建 CosyVoice 专属 venv 并安装 `cosyvoice.requirements.lock`，再执行 `pip check` 和 TTS worker 版本自检。主 worker 用 Qwen 回读 TTS worker 的 WAV，二者都绝不读取 SQLite、调用 Recut HTTP API 或写入素材库。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
