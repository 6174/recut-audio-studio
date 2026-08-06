---
name: audio-studio
description: 对本地音视频执行转写生成字幕文稿、用参考音创建声音角色并合成角色配音。
---

# 声音工坊执行约束

此 App 只使用 `audio.status`、`audio.prepare`、`audio.install`、`audio.transcribe`、`audio.transcripts`、`audio.transcript`、`audio.character.create`、`audio.character.complete`、`audio.characters`、`audio.character.remove`、`audio.synthesize`、`audio.synthesis.complete`、`audio.syntheses` 和 `audio.save` 的公开契约。

- 应用进入时先自动调用 `audio.status -> audio.prepare`；运行依赖未就绪时不能开放工作台。转写前确认用户选择的 Whisper 或 Qwen3-ASR 模型已经下载；模型下载的 `source` 只能是 `automatic`、`huggingface` 或 `modelscope`，自动模式先尝试 Hugging Face 再回退 ModelScope；配音前确认 CosyVoice2 权重已下载且至少存在一个已完成的声音角色。
- 输入必须是已完成的 Recut Media Asset（`audio.transcribe` 接受 audio 或 video，`audio.character.create` 只接受 audio）。所有操作只把素材复制到 App 私有文件目录。
- `audio.transcribe` 只提交 Job，产出 `transcript.json` 文稿与 SRT 字幕；`audio.transcript` 在 Job 成功后读取分段和 SRT。转写结果不能作为媒体 Asset 入库。
- 创建声音角色时，参考音频会被裁剪到前 30 秒，并以已安装的 Whisper 或 Qwen3-ASR 模型自动转写生成角色提示词（`audio.character.create` 异步提交、`audio.character.complete` 读取结果）。没有提示词的角色不能用于 `audio.synthesize`。
- `audio.synthesize` 只提交 Job，`audio.synthesis.complete` 在 Job 成功后取得私有 `outputURL`。只有用户明确点击保存后，才允许调用 `audio.save` 把配音或角色参考音导入素材库。
- Python venv、依赖和路径只由 `manifest.runtime.python` 与平台 `ctx.python` 管理；`bootstrap.sh` 只能做自由兜底，不能重建 venv 或重复 pip 安装。
- 依赖、模型下载、转写、角色准备或合成失败时，保留原始错误。不要编造转写结果、假设模型已安装，或绕开 App 直接写入 `.recut/models`。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
