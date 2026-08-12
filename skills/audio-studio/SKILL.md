---
name: audio-studio
description: 对本地音视频执行转写生成字幕文稿、用参考音创建声音角色并合成角色配音。
---

# 声音工坊执行约束

此 App 只使用 `audio.status`、`audio.prepare`、`audio.install`、`audio.transcribe`、`audio.transcripts`、`audio.transcript`、`audio.character.create`、`audio.character.complete`、`audio.characters`、`audio.character.remove`、`audio.synthesize`、`audio.synthesis.complete`、`audio.syntheses` 和 `audio.save` 的公开契约。

- 应用进入时先自动调用 `audio.status -> audio.prepare`；运行依赖未就绪时不能开放工作台。转写前确认用户选择的 Whisper 或 Qwen3-ASR 模型已经下载；模型下载的 `source` 只能是 `automatic`、`huggingface` 或 `modelscope`，自动模式先尝试 Hugging Face 再回退 ModelScope；配音前必须同时确认 CosyVoice 专属官方 venv、CosyVoice2 权重与 Qwen3-ASR 0.6B 回读器可用，未选择角色时使用官方默认声音。
- 输入必须是已完成的 Recut Media Asset（`audio.transcribe` 接受 audio 或 video，`audio.character.create` 只接受 audio）。所有操作只把素材复制到 App 私有文件目录。
- `audio.transcribe` 只提交 Job，产出 `transcript.json` 文稿与 SRT 字幕；`audio.transcript` 在 Job 成功后读取分段和 SRT。转写结果不能作为媒体 Asset 入库。
- 所有耗时操作（`audio.prepare` / `audio.install` / `audio.transcribe` / `audio.character.create` / `audio.synthesize`）都是异步提交、立即返回 job；用平台 `recut.job.status` / `recut.job.wait` 轮询终态，失败用 `recut.job.logs` 诊断、`recut.job.cancel` 取消，不要用同步等待代替轮询。`audio.status` 的 activeJob 只用于确认当前 App 任务归属。
- 创建声音角色时，VoiceCloneEngine 会先预处理最多 60 秒输入，自动挑选 3~6 秒连续人声并归一化；波形、CosyVoice 声纹和“提示词朗读 -> ASR 回读”均通过验收后，才允许角色完成（`audio.character.create` 异步提交、`audio.character.complete` 读取结果）。没有完整验收记录的旧角色不能用于 `audio.synthesize`。
- `audio.synthesize` 只提交 Job，worker 合成后必须经过 Qwen3-ASR 回读，且双向文本相似度至少 `0.85`；未通过的 WAV 会删除，`audio.synthesis.complete` 不会暴露它。只有用户明确点击保存后，才允许调用 `audio.save` 把已验收配音或角色参考音导入素材库。
- 平台 `ctx.python` venv 承载 Qwen/Whisper ASR，`requirements.lock` 固定完整依赖闭包；`bootstrap.py` 在同级创建 CosyVoice 专属 venv，固定安装 `cosyvoice.requirements.lock` 的完整闭包、固定 CosyVoice/Matcha-TTS 源码提交，并执行 `pip check` 与 worker 版本自检。二者不可合并，因为 Qwen3-ASR 与 CosyVoice2 对 transformers 版本存在不可调和的约束。
- 依赖、模型下载、转写、角色准备或合成失败时，保留原始错误。不要编造转写结果、假设模型已安装，或绕开 App 直接写入 `.recut/models`。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
