# 声音工坊 - 本地转写、声音角色与配音 App

声音工坊是 Recut 的独立应用，把声音当作视频创作里的一级资源：

1. **转写**：选择素材库里的音频或视频，在本机用 Whisper 或 Qwen3-ASR 转写，产出可编辑文稿（`transcript.json`）和真实时间戳 SRT 字幕。
2. **声音角色**：上传人声后，VoiceCloneEngine 自动预处理音频、选取 3~6 秒连续人声、验证波形与 CosyVoice 声纹，并仅为通过验收的片段生成角色提示词，形成可复用的声音角色。
3. **配音**：输入文本即可用 CosyVoice 官方默认声音合成；也可选择已验收的声音角色，用 CosyVoice2 的声纹克隆路径合成角色朗读。

输出先保留在 App 私有文件区，用户点击保存后才创建素材库 Asset。

## 使用流程

1. 在 **Apps** 中从 [recut-audio-studio](https://github.com/6174/recut-audio-studio) 安装并打开“声音工坊”。首次进入会自动准备 Python、FFmpeg 与模型：平台优先使用 manifest 指定的 **Python 3.11**，缺少时把受管版本安装到 Recut 数据目录；FFmpeg 同样在隔离环境中自动提供。随后创建 venv、安装锁定依赖与执行跨平台 App bootstrap（下载 [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) 官方代码并安装其推理运行依赖），不会要求用户配置解释器、Homebrew、PATH 或 shell。
2. **转写**：选择 Qwen3-ASR 0.6B / 1.7B 或 Whisper Small / Medium / Large-v3（可多选），选择 Hugging Face、ModelScope 或自动回退来源，下载后选择音频或视频素材与语言；生成后先查看文稿与字幕，再按需保存或复制。保存会创建 platform 的 `transcript` 素材：一个 bundle 同时包含与时间戳对齐的源声音轨、SRT 字幕与 transcript.json，可在素材库直接播放、按分段阅读或下载 SRT/JSON。Qwen 会同时安装官方时间戳对齐器。
3. **声音角色**：确认已安装任一语音模型，从素材库选择一段人声音频，命名后创建角色；创建过程自动筛选短连续人声、验收波形和 CosyVoice 声纹，再生成角色提示词。未通过验收的输入不会创建角色。
4. **配音**：确认已下载 CosyVoice2 权重，输入文本后可直接使用官方默认声音，或选择已验收的角色；生成后先试听私有预览，满意时保存到素材库。

模型权重统一保存到 `~/.recut/models/audio-studio/`，venv 由平台保存到 `~/.recut/python/envs/recut.audio-studio/audio-studio/<fingerprint>/`。

## 本地依赖

`manifest.json` 的 `runtime.python` 是 ASR 环境声明：平台自动取得声明的 Python 版本与 FFmpeg，创建 venv、按完整版本闭包 `python/requirements.lock` 安装 Qwen 官方 `qwen-asr` 与 faster-whisper。`bootstrap.py` 随后用同一 Python 创建并维护同级的 CosyVoice 专属 venv，严格安装完整版本闭包 `python/cosyvoice.requirements.lock`（torch/torchaudio 2.3.1、transformers 4.51.3、numpy 1.26.4），与 Qwen 所需 transformers 4.57.6 彻底隔离；安装后必须通过 `pip check` 与 worker 版本自检。CosyVoice 和 Matcha-TTS 代码也固定到验收提交，不追随 `main`。每次模型下载都可选择 Hugging Face 或 ModelScope；自动模式先尝试 Hugging Face，失败后改用 ModelScope。Whisper 权重来自 Systran/faster-whisper-*；Qwen 模型来自 Qwen/Qwen3-ASR-*，并配套 Qwen3-ForcedAligner-0.6B；CosyVoice2-0.5B 来自 FunAudioLLM/CosyVoice2-0.5B。角色创建会合成自身提示词并 ASR 回读校准，最终 TTS 也必须完成“合成 -> Qwen3-ASR 回读 -> 文本保真度 >= 0.85”才会暴露 WAV；失败结果会被删除，不能进入历史或素材库。

## 数据边界

| 数据 | 保存位置 |
| --- | --- |
| CosyVoice 官方代码、Whisper、Qwen3-ASR（含对齐器）与 CosyVoice2 权重 | `~/.recut/models/audio-studio/` |
| 平台 Python venv | `~/.recut/python/envs/recut.audio-studio/audio-studio/<fingerprint>/` |
| 输入副本、文稿、SRT、源声音轨、角色参考音与未保存配音 | 当前独立 App 的私有文件沙箱 |
| 用户明确保存的配音、角色参考音或转写 bundle（源声音 + SRT + JSON） | Recut 素材库，取得真实 `assetId` |
| 转写 / 角色 / 合成记录 | 当前 App 的隔离 SQLite |

> 跨 App 能力面：`audio.transcribe` / `audio.transcripts` / `audio.transcript` / `audio.status` 已在 manifest 标记 `capability: true`，可被其他 App 经平台通用能力桥（`ctx.capabilities.invoke`）复用。`audio.transcribe` 新增 `saveToLibrary` 开关（默认 `false` = 私有产物不自动入库；`true` = 完成时懒终态自动导入为全局 transcript 素材，幂等去重——编辑器「生成字幕」即一次调用转写+入库）。Agent 直连不传该开关，行为保持私有产物。

## 架构

```text
ui/ -> background.js -> ctx.python / ctx.shell -> ShellJobManager -> python/audio_runner.py
                          |                         |                     |
                          |                         +-> project events   +-> ~/.recut/models/audio-studio/
                          +-> App files/inputs, transcripts, characters, syntheses

素材库 Asset -> ctx.media.materialize -> 私有输入副本 -> Whisper / Qwen3-ASR / CosyVoice 处理
用户点击保存 -> ctx.media.importFile -> 素材库 Asset
```

`background.js` 是唯一业务入口。它把模型下载源持久化在 App SQLite，把素材库输入 materialize 到私有目录、提交 Python Job、保存转写 / 角色 / 合成记录，并在 App SQLite 保留一个活动任务及其持久化日志；界面重连后通过 `audio.job` 恢复，任务可以由 `audio.cancel` 停止，只有处理完终态才以 `audio.resolve` 清除。CosyVoice worker 的加载、参考音编码、推理分片和 WAV 写入会实时转发；若底层模型连续 8 秒无输出，主 worker 会持续输出运行心跳，因此界面不会把正常计算误判为卡死。记录以任务终态驱动：只有成功生成、波形有效且在生成完成后经一次 ASR 回读、文本保真度达标的 WAV 进入历史。转写文稿以 `segments: [{ start, end, text, speaker, emotion }]` 结构保存，SRT 只是导出展示格式；声音角色由 VoiceCloneEngine 生成：预处理参考音、选出 3~6 秒连续语音、归一化、验收波形和 CosyVoice 声纹，再以一次“合成->ASR 回读”校准，只有带完整验收记录的角色能进入 TTS。未选择角色时，合成固定使用 CosyVoice 仓库随附的 `zero_shot_prompt.wav` 及其官方对应文本；选择角色时才使用角色的短样本和对应转写。`python/audio_runner.py` 负责状态、下载、转写、策略和验收，`python/tts_runner.py` 在官方锁定的独立 TTS venv 中加载 CosyVoice，`python/whisper_shim.py` 只在该 worker 的加载期注入兼容边界。

## 开发

```sh
make app-link APP=apps/audio-studio
cd apps/audio-studio/ui
npm install
npm run build
```

构建后的 `ui/dist/` 是 `manifest.json` 的运行时入口。模型下载、Python 依赖安装和实际推理由服务进程触发，不应在 UI 打包流程中执行。

## 目录结构

```text
AGENTS.md               Agent 执行边界与生成/保存规则
background.js           App SQLite、素材复制、Python 调用与显式导入素材库的 operation
bootstrap.py            固定 CosyVoice/Matcha-TTS 源码提交、创建专属 TTS venv、安装完整锁文件并验证依赖闭包
manifest.json           独立 App 身份、权限和 operation 契约
python/                 平台 venv 的 lockfile、模型下载和转写/角色/合成 launcher
rfc/                    设计决策：如双引擎配音（IndexTTS-2.5）方案
skills/                 App skill：约束 Agent 只能使用公开 operation 契约
ui/                     React/Vite 运行环境、模型管理、转写、角色、配音与预览工作台
```

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
