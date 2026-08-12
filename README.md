# 声音工坊 - 本地转写、声音角色与配音 App

声音工坊是 Recut 的独立应用，把声音当作视频创作里的一级资源：

1. **转写**：选择素材库里的音频或视频，在本机用 Whisper 或 Qwen3-ASR 转写，产出可编辑文稿（`transcript.json`）和真实时间戳 SRT 字幕。
2. **声音角色**：上传一段 5~15 秒干净人声，App 抽取 16k 参考音并用所选的 Whisper 或 Qwen3-ASR 自动生成角色提示词，形成可复用的声音角色。
3. **配音**：选择声音角色与一段文本，在本机用 CosyVoice2 零样本合成角色朗读，可额外选择情绪指令（平静 / 兴奋 / 温柔）。

输出先保留在 App 私有文件区，用户点击保存后才创建素材库 Asset。

## 使用流程

1. 在 **Apps** 中从 [recut-audio-studio](https://github.com/6174/recut-audio-studio) 安装并打开“声音工坊”。首次进入会自动准备 Python、FFmpeg 与模型：平台优先使用 manifest 指定的 **Python 3.11**，缺少时把受管版本安装到 Recut 数据目录；FFmpeg 同样在隔离环境中自动提供。随后创建 venv、安装锁定依赖与执行跨平台 App bootstrap（下载 [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) 官方代码），不会要求用户配置解释器、Homebrew、PATH 或 shell。
2. **转写**：选择 Qwen3-ASR 0.6B / 1.7B 或 Whisper Small / Medium / Large-v3（可多选），选择 Hugging Face、ModelScope 或自动回退来源，下载后选择音频或视频素材与语言；生成后先查看文稿与字幕，再按需保存或复制。保存会创建 platform 的 `transcript` 素材：一个 bundle 同时包含与时间戳对齐的源声音轨、SRT 字幕与 transcript.json，可在素材库直接播放、按分段阅读或下载 SRT/JSON。Qwen 会同时安装官方时间戳对齐器。
3. **声音角色**：确认已安装任一语音模型，从素材库选择一段人声音频，命名后创建角色；创建过程自动生成角色提示词。
4. **配音**：确认已下载 CosyVoice2 权重并至少有一个角色，输入文本、选择角色和情绪，生成后先试听私有预览，满意时保存到素材库。

模型权重统一保存到 `~/.recut/models/audio-studio/`，venv 由平台保存到 `~/.recut/python/envs/recut.audio-studio/audio-studio/<fingerprint>/`。

## 本地依赖

`manifest.json` 的 `runtime.python` 是唯一的环境声明：平台自动取得声明的 Python 版本与 FFmpeg，创建 venv、按 `python/requirements.lock` 安装 PyTorch、faster-whisper、Qwen 官方 `qwen-asr` 与 CosyVoice 推理依赖；`bootstrap.py` 是跨平台兜底脚本，用受管 Python 下载 CosyVoice 与 Matcha-TTS 官方代码。每次模型下载都可选择 Hugging Face 或 ModelScope；自动模式先尝试 Hugging Face，失败后改用 ModelScope。Whisper 权重来自 Systran/faster-whisper-*；Qwen 模型来自 Qwen/Qwen3-ASR-*，并配套 Qwen3-ForcedAligner-0.6B；CosyVoice2-0.5B 来自 FunAudioLLM/CosyVoice2-0.5B。安装、下载、转写、角色准备和合成均作为可取消任务运行，进度和错误显示在界面和项目事件流中，错误可直接交给右侧 Codex 处理。

## 数据边界

| 数据 | 保存位置 |
| --- | --- |
| CosyVoice 官方代码、Whisper、Qwen3-ASR（含对齐器）与 CosyVoice2 权重 | `~/.recut/models/audio-studio/` |
| 平台 Python venv | `~/.recut/python/envs/recut.audio-studio/audio-studio/<fingerprint>/` |
| 输入副本、文稿、SRT、源声音轨、角色参考音与未保存配音 | 当前独立 App 的私有文件沙箱 |
| 用户明确保存的配音、角色参考音或转写 bundle（源声音 + SRT + JSON） | Recut 素材库，取得真实 `assetId` |
| 转写 / 角色 / 合成记录 | 当前 App 的隔离 SQLite |

## 架构

```text
ui/ -> background.js -> ctx.python / ctx.shell -> ShellJobManager -> python/audio_runner.py
                          |                         |                     |
                          |                         +-> project events   +-> ~/.recut/models/audio-studio/
                          +-> App files/inputs, transcripts, characters, syntheses

素材库 Asset -> ctx.media.materialize -> 私有输入副本 -> Whisper / Qwen3-ASR / CosyVoice 处理
用户点击保存 -> ctx.media.importFile -> 素材库 Asset
```

`background.js` 是唯一业务入口。它把模型下载源持久化在 App SQLite，把素材库输入 materialize 到私有目录、提交 Python Job、保存转写 / 角色 / 合成记录，并在 App SQLite 保留一个活动任务及其持久化日志；界面重连后通过 `audio.job` 恢复，任务可以由 `audio.cancel` 停止，只有处理完终态才以 `audio.resolve` 清除。同步状态检查与异步推理都显式使用平台注入的 `RECUT_PYTHON`，因此必定运行在 manifest 对应的隔离 venv，而不会误用宿主 `python3`。记录以任务终态驱动：只有成功生成且可预览的文件进入历史。转写文稿以 `segments: [{ start, end, text, speaker, emotion }]` 结构保存，SRT 只是导出展示格式；声音角色由 `sample.wav` 与自动生成的 `promptText` 组成，配音据此零样本合成。它绝不在生成成功时导入素材库。`python/audio_runner.py` 不管理 venv、pip 或官方仓库，不了解 App SQLite 或素材库，只负责模型状态、下载、转写与合成。

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
bootstrap.py            跨平台的 CosyVoice 官方代码准备兜底脚本；不拥有 venv 或 pip 生命周期
manifest.json           独立 App 身份、权限和 operation 契约
python/                 平台 venv 的 lockfile、模型下载和转写/角色/合成 launcher
skills/                 App skill：约束 Agent 只能使用公开 operation 契约
ui/                     React/Vite 运行环境、模型管理、转写、角色、配音与预览工作台
```

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
