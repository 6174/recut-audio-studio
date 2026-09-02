---
name: audio-studio
description: 对本地音视频执行转写生成字幕文稿、用参考音创建声音角色并合成角色配音。
---

# 声音工坊执行约束

此 App 只使用 `audio.status`、`audio.prepare`、`audio.install`、`audio.transcribe`、`audio.transcripts`、`audio.transcript`、`audio.presets`、`audio.character.create`、`audio.character.complete`、`audio.character.design`、`audio.characters`、`audio.character.remove`、`audio.synthesize`、`audio.synthesis.complete`、`audio.syntheses` 和 `audio.save` 的公开契约。

- 应用进入时先自动调用 `audio.status -> audio.prepare`；运行依赖未就绪时不能开放工作台。Agent 会话内 `audio.status` 只读一次：之后的就绪判断（转写模型已下载、配音引擎 venv/权重就绪）都基于已知状态，只有环境实际报错才重读，不为每次转写或配音预检。转写前确认用户选择的 Whisper 或 Qwen3-ASR 模型已经下载；模型下载的 `source` 只能是 `automatic`、`huggingface` 或 `modelscope`，自动模式先尝试 Hugging Face 再回退 ModelScope；配音引擎要求：CosyVoice 需要 CosyVoice 专属官方 venv、CosyVoice2 权重与 Qwen3-ASR 0.6B 回读器；VoxCPM 需要 `engines.voxcpm.runtime` 与其某版本权重（`voxcpm2` 约 5.0GB / `voxcpm1.5` 约 2.0GB / `voxcpm-0.5b` 约 1.6GB）。未选择角色时，CosyVoice 使用官方默认声音，VoxCPM2 使用 Voice Design 默认音（无参考音），VoxCPM1.5/0.5B 必须提供声音角色参考音。
- 输入必须是已完成的 Recut Media Asset（`audio.transcribe` 接受 audio 或 video，`audio.character.create` 只接受 audio）。所有操作只把素材复制到 App 私有文件目录。
- `audio.transcribe` 只提交 Job，产出 `transcript.json` 文稿与 SRT 字幕；`audio.transcript` 在 Job 成功后读取分段和 SRT。转写结果不能作为媒体 Asset 入库。
- 所有耗时操作（`audio.prepare` / `audio.install` / `audio.transcribe` / `audio.character.create` / `audio.character.design` / `audio.synthesize`）都是异步提交、立即返回 job；用平台 `recut.job.status` / `recut.job.wait` 轮询终态，失败用 `recut.job.logs` 诊断、`recut.job.cancel` 取消，不要用同步等待代替轮询。`audio.status` 的 activeJob 只用于确认当前 App 任务归属。
- 创建声音角色时，VoiceCloneEngine 会先预处理最多 60 秒输入，自动挑选 3~6 秒连续人声并归一化；波形、CosyVoice 声纹和“提示词朗读 -> ASR 回读”均通过验收后，才允许角色完成（`audio.character.create` 异步提交、`audio.character.complete` 读取结果）。没有完整验收记录的旧角色不能用于 `audio.synthesize`。
- `audio.synthesize` 只提交 Job；worker 合成后必须经过 Qwen3-ASR 回读，且双向文本相似度至少 `0.85`；未通过的 WAV 会删除，`audio.synthesis.complete` 不会暴露它。`engine` 缺省 `cosyvoice2`，可选 `voxcpm2` / `voxcpm1.5` / `voxcpm-0.5b`；VoxCPM 输出支持 30 语种但回读验收目前只保证中英。用户明确点击保存后（或平台把本机 TTS 选为语音默认路由时，`recut.speech.generate` 的 local-audio 路由经 daemon 桥调用），允许 `audio.save` 把已验收配音导入素材库。
- 模型任务的执行日志必须持续可见：CosyVoice / VoxCPM worker 实时输出代码准备、权重加载、参考音编码、推理分片和 WAV 写入；主 worker 在底层模型连续 8 秒无输出时发送心跳。VoxCPM 的独立 venv 创建与依赖安装过程会流式输出到任务日志（`audio.install` 下载 voxcpm 版本前会先安装该运行环境）。ASR 只在完整 WAV 写出后执行一次回读验收，不在合成过程中重复运行。
- 平台 `ctx.python` venv 承载 Qwen/Whisper ASR，`requirements.lock` 固定完整依赖闭包；`bootstrap.py` 在同级创建 CosyVoice 专属 venv 与 VoxCPM 专属 venv，固定安装各自锁文件的依赖闭包、固定 CosyVoice/Matcha-TTS 源码提交，并执行 `pip check` 与 worker 版本自检。三者不可合并，因为 Qwen3-ASR、CosyVoice2 与 VoxCPM 对 torch/transformers 版本存在不可调和的约束。VoxCPM 运行环境在 `prepare` 中尽力准备（失败不阻断），`audio.status` 的 `engines.voxcpm.runtime` 暴露状态。
- 依赖、模型下载、转写、角色准备或合成失败时，保留原始错误。不要编造转写结果、假设模型已安装，或绕开 App 直接写入 `.recut/models`。
- `audio.presets` 是只读枚举 op、无副作用：返回 CDN catalog（离线时回退 bootstrap 清单）中的默认声音预设（id、名称、场景标签、听感一句话、本地缓存状态），可直接用于了解可用声线；不产生任何 job。

## 为 World 角色设计声音参考

AI 创建 World 角色（`recut.worlds.entities.upsert` character）需要 voice_reference 证据时，按以下链路操作：

1. `audio.presets` 枚举默认声音预设，按角色人设挑选 scene/presetId；没有合适预设时，按人设自写中文 designDesc。写法模板：**年龄/性别 + 音色质地 + 语速节奏 + 参照场景**，只描述声线特征，不写真实人名（例：「一位低沉的中文男声，语速缓慢克制，像深夜电台讲述者」）。
2. `audio.character.design { name: 角色名, presetId|designDesc, saveToLibrary: true }`（二选一传入，异步 job）→ `recut.job.wait` 等待终态 → 拿到角色参考音入库后的 `assetId`。
3. `recut.worlds.entities.upsert`（character）时内联证据，或 `recut.worlds.evidence.attach` 一条 `{ role: "voice_reference", assetId: <上一步的 assetId> }`。
4. 纪律：**不克隆真人声音**；designDesc 只描述声线特征，不得指向真实自然人（含网红、配音演员）。预设固化产物是共享缓存，design 产出的用户角色才是可删除的私有资产。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
