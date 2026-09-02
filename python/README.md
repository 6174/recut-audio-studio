# python/

> L2 | 父级: /apps/audio-studio/README.md

成员清单
audio_runner.py: 本机工作流入口；下载与转写仍在平台 ASR venv 内执行，VoiceCloneEngine 自动选取 3~6 秒连续人声、验收波形/声纹，并在创建角色及最终合成时使用 ASR 回读守门；底层模型静默超过 8 秒会发出运行心跳，只有文本保真度达标的 WAV 可交付。另承载声音预设能力：presets 枚举（CDN manifest → bootstrap 兜底）、resolve_preset（缓存 → CDN 下载 + sha256 校验 + 版本化缓存）、design-character（预设实例化 / VoxCPM2 Voice Design 探针 + 回读验收建角色）与 synthesize 的 --preset-id 参考音路径。
publish_presets.py: 官方预设发布管线；单一信息源是包内 presets/catalog.json（改预设只改它），从它读取 20 条 designDesc 批量生成探针、离线 ASR 回读验收并产出 CDN manifest.json 与 WAV（写入 publish/presets/<version>/）。`--sync` 再生成 background.js 兜底清单块并暂存 cdn/buckets/voices/（随后 `make voices-upload` 上传 R2）。
tts_runner.py: CosyVoice 专属 worker；只加载官方固定版本组合，逐阶段实时报告代码准备、权重加载、提示词编码、推理分片与 WAV 写入，末行输出 JSON，绝不导入 Qwen3-ASR。
requirements.lock: 平台 ASR venv 的完整版本闭包；逐项固定经验证的 Qwen3-ASR 0.0.6、faster-whisper 1.2.1 与所有传递依赖，不承载 CosyVoice。
cosyvoice.requirements.lock: CosyVoice 官方 TTS venv 的完整版本闭包；逐项固定 torch/torchaudio 2.3.1、transformers 4.51.3、numpy 1.26.4 与所有传递依赖，隔离 Qwen 冲突。
whisper_shim.py: CosyVoice worker 的兼容边界；向 sys.modules 注入 vendored 的 whisper / whisper.tokenizer / modelscope 占位，并把 CosyVoice 的 load_wav 替换为 soundfile 实现。

依赖关系

`background.js -> ctx.python.run -> audio_runner.py -> tts_runner.py`；平台先创建 ASR venv 并安装 `requirements.lock`，随后 `bootstrap.py` 在其同级创建 CosyVoice 专属 venv 并安装 `cosyvoice.requirements.lock`，再执行 `pip check` 和 TTS worker 版本自检。主 worker 用 Qwen 回读 TTS worker 的 WAV，二者都绝不读取 SQLite、调用 Recut HTTP API 或写入素材库。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
