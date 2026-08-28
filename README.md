<div align="center">

<img src="./assets/logo.jpg" alt="Recut logo" width="112" />

# 声音工坊 · Audio Studio

**在本机把音视频转成字幕与文稿，用已授权的声音角色完成旁白与配音**

Recut 的本地声音工作台 — 转写、声音角色与配音在同一条工作流中完成

[中文](./README.md) · [English](./README.en.md)

</div>

![Recut Audio Studio 声音工坊](./assets/audio-studio.jpg)

## 这是什么

声音工坊是 Recut 的**独立声音 App**（`standalone` 类型）。它把声音当作视频创作的一级资源，在本机完成从听见、到复用到再创作的闭环：转写产出带时间戳的文稿与字幕，声音角色沉淀可复用的音色，配音把新文本读出来。

- **先在本机听懂**：用 Whisper 或 Qwen3-ASR 在本地转写，不把原始音视频默认交给云端。
- **结果先私有，确认后再入库**：转写、角色与配音先保留在 App 私有文件区，用户明确保存后才创建素材库 Asset。
- **与剪辑器同源**：保存的 transcript 素材可直接在剪辑器中生成字幕轨、绑定文稿继续剪辑。

> 通过 **Apps** 从 [recut-audio-studio](https://github.com/6174/recut-audio-studio) 安装。首次使用会自动准备 Python 3.11、FFmpeg 与模型（见 manifest `runtime.python`）。

## 为什么用它

### 本地转写，时间戳可信

基于 Whisper（Small / Medium / Large-v3）与 Qwen3-ASR（0.6B / 1.7B，含 Qwen3-ForcedAligner 时间戳对齐），产出 `transcript.json` 文稿与真实时间戳 SRT。所有合成输出需经 ASR 回读校准（文本保真度 ≥ 0.85）才进入历史。

### 声音角色是可复用的音色资产

从一段人声素材自动截取 3–6 秒连续人声、验证波形与声纹，回读校准通过后才生成角色。未通过验收的输入不会创建角色。

### 双引擎配音，按需选择

默认 **CosyVoice2**（官方默认声音或声纹克隆），可选 **VoxCPM**（VoxCPM2 约 5.0GB / VoxCPM1.5 约 2.0GB / VoxCPM-0.5B 约 1.6GB）：VoxCPM2 支持 30 语种与 Voice Design 默认音，VoxCPM1.5/0.5B 需提供角色参考音。

### 与剪辑器字幕工作流打通

转写保存为平台 `transcript` 素材（源声音 + SRT + JSON bundle），剪辑器经能力桥（`audio.transcribe` / `audio.save`）一键生成字幕轨并绑定可编辑文稿。

## 从想法到成片

1. **准备环境**：首次打开自动准备依赖；或按需下载模型（Hugging Face / ModelScope / 自动回退）。
2. **转写**：选择素材库中的音频或视频、模型与语言，生成文稿与 SRT，满意后保存为 transcript 素材。
3. **创建声音角色**：选择一段人声素材命名并创建，系统自动预处理与验收。
4. **配音**：输入文本，选择引擎与角色（可选），试听私有预览后保存为音频素材。
5. **回到剪辑器**：在时间线上使用字幕与配音素材继续编排与导出。

## 核心能力

| 能力 | 你能做什么 | 关键操作 |
| --- | --- | --- |
| **本地转写** | 音/视频转带时间戳文稿与 SRT，支持中/英/自动 | `audio.transcribe` · `audio.transcript` · `audio.transcripts` |
| **声音角色** | 从参考音创建可复用角色，自动验收声纹与回读 | `audio.character.create` · `audio.characters` · `audio.character.remove` |
| **配音合成** | 用默认声音或角色朗读新文本，支持 CosyVoice2 / VoxCPM 三档 | `audio.synthesize` · `audio.syntheses` |
| **保存入库** | 将私有文稿/配音/角色参考音保存为素材库 Asset | `audio.save` |
| **环境与模型** | 检查 Python/FFmpeg/模型与引擎就绪状态，按需安装 | `audio.status` · `audio.prepare` · `audio.install` |
| **任务中心** | 统一查看、检索与取消所有任务，查看持久化日志 | `audio.tasks.list` · `audio.task.get` · `audio.task.logs` · `audio.task.cancel` |

> 完整操作契约见 `manifest.json` 的 `operations` 列表；跨 App 复用标有 `capability: true` 的操作。

## 快速开始

### 在 Recut 中打开

1. 安装并启动 Recut（见主仓库 [README](../../README.md#安装-recut)）。
2. 在 **Apps** 中安装 **声音工坊** 并打开。
3. 首次进入按提示完成环境准备与模型下载（`audio.status` 可查看进度）。

### 让 Agent 帮你做

在 Claude Code / OpenCode / Codex Cli 中对项目说：

> “用声音工坊处理这个请求【把这段视频转写成中文字幕，保存后在剪辑器里生成字幕轨】。先读 audio.status 确认模型就绪，再调用 audio.transcribe，完成后保存并在剪辑器中落轨。”

Agent 会经能力桥调用转写与保存，结果回到素材库与时间线。

## 界面导览

- **模型管理**：选择并下载 Whisper / Qwen3-ASR / CosyVoice2 / VoxCPM 权重，切换下载源。
- **转写**：选择素材与语言，查看分段文稿与 SRT 预览，保存为 transcript 素材。
- **声音角色**：从素材库选择参考音、命名创建，查看验收结果与角色列表。
- **配音**：输入文本、选择引擎与角色，试听并保存。
- **任务与日志**：查看当前与历史任务状态，打开持久化日志，取消运行中任务。

![声音工坊界面](./assets/audio-studio.jpg)
<sub>转写、声音角色与配音在同一工作区协作，结果经确认后进入素材库。</sub>

## 常见问题

**转写或配音按钮不可用？** 先在 `audio.status` 中检查 Python、FFmpeg 与模型是否就绪，未就绪时按引导执行 `audio.prepare` / `audio.install`。

**声音角色创建失败？** 参考音需包含清晰、连续的人声片段；系统会验证波形与声纹，未通过验收的输入不会创建角色，建议更换更干净的人声素材重试。

**VoxCPM 模型很大，下载失败怎么办？** 可在模型管理中切换 Hugging Face / ModelScope / 自动回退来源；VoxCPM 首次使用会先安装独立 venv，日志可在任务中心查看。

**保存后在哪里找到结果？** 转写保存为 `transcript` 素材（bundle 含源声音、SRT 与 JSON），配音保存为音频素材，均可在全局素材库与剪辑器素材面板中使用。

## 面向开发者

声音工坊是独立 Recut App。UI 源码在 `ui/`（React + TypeScript + Vite），后台按 `manifest.json` 的 `background` 与 `operations` 契约运行。

```sh
make app-link APP=apps/audio-studio
cd apps/audio-studio/ui
npm install
npm run build
```

- 运行时消费 `ui/dist/index.html`，`ui/dist/` 与 `node_modules/` 不入库。
- 模型权重保存到 `~/.recut/models/audio-studio/`；venv 位于 `~/.recut/python/envs/recut.audio-studio/`。
- 架构与契约：`manifest.json` · `background.js` · `bootstrap.py` · `python/` · `skills/`。

[返回主 README](../../README.md) · [应用地图](../../README.md#应用地图)
