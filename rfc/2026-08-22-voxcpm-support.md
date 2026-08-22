<!--
 * [INPUT]: 依赖 audio-studio 现状（background.js 的 audio.synthesize/install/status 与任务模型、audio_runner.py 的 CosyVoice 合成与 Qwen3-ASR 回读验收、bootstrap.py 的专属 venv 隔离模式、ui 的三步工作流与配音控件、manifest 的 operation 契约）、
 *          以及 VoxCPM 上游事实（OpenBMB/VoxCPM 2.0.3 pip 包、VoxCPM2/1.5/0.5B 三个版本与体积、generate() 的 reference/prompt 克隆与 Voice Design 前缀、torch>=2.5.0 / Python>=3.10 约束、Apache-2.0 许可证）
 * [OUTPUT]: 定义声音工坊支持 VoxCPM 的整体方案：产品决策为「配音步骤加引擎选择器 + 版本卡片」；
 *          新增与 ASR/CosyVoice 隔离的第三个专属 venv 与 voxcpm_runner.py worker；manifest/background 的 engine+version 契约、
 *          audio_syntheses 记录加列、status 的 engines.voxcpm 结构、UI 的引擎选择 + 版本选择（含体积提示）+ 独立 venv 安装引导 + 日志可见的 venv 安装过程，
 *          以及分阶段实施与分层验证
 * [POS]: rfc 的 audio-studio VoxCPM 多版本配音实施蓝图；获批后落到 manifest/background.js、audio_runner.py + voxcpm_runner.py、
 *        bootstrap.py + voxcpm.requirements.lock、ui/src/main.tsx + i18n.ts + types.ts，并反向更新 README 与 SKILL.md
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 -->

# RFC: 声音工坊支持 VoxCPM——多版本本地 TTS 引擎（版本选择 + 独立 venv + 日志引导）

- 状态：**已采纳（本文件即实施蓝图）**
- 作者：Recut
- 日期：2026-08-22
- 决策范围：产品形态（引擎选择器 + 版本卡片）、版本与体积、引擎/运行时隔离、Install 目标、operation 与数据契约、UI 参数与引导、验收与验证、分阶段实施、不采纳边界
- 关联：`manifest.json`、`background.js`、`python/audio_runner.py`、`python/voxcpm_runner.py`（新增）、`python/cosyvoice.requirements.lock`、`python/voxcpm.requirements.lock`（新增）、`bootstrap.py`、`skills/audio-studio/SKILL.md`、`ui/src/main.tsx`、`ui/src/types.ts`、`ui/src/i18n.ts`、`README.md`、上游 `github.com/OpenBMB/VoxCPM`（voxcpm 2.0.3，2026 系列发布）

## 1. 背景与病灶

声音工坊目前只有**一条本地配音链路**：`audio.synthesize(text, characterId?, style)` → `audio_runner.synthesize()` → `tts_runner.py`（CosyVoice 专属 venv 内的 `CosyVoice2`）→ 写出 WAV → `Qwen3-ASR 0.6B 回读验收（保真度 ≥ 0.85）` → 私有预览 / 显式入库。声音角色由 `VoiceCloneEngine` 创建：预处理 → 选 3~6 秒连续人声 → 波形验收 → CosyVoice 声纹验证 → ASR 生成提示词 → 「合成→回读」校准。

对照上游 [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM)（`pip install voxcpm`，Apache-2.0），VoxCPM 在三个维度补足当前缺口：

1. **多语言**：VoxCPM2 支持 30 种语言，输入文本无需语言标签；CosyVoice2 只做中英。
2. **Voice Design**：VoxCPM2 可用自然语言描述直接「设计」新音色（`(描述)文本` 前缀），无需参考音——这是 CosyVoice 没有的能力，可低成本充当「官方默认音」。
3. **可控克隆**：`reference_wav_path`（VoxCPM2 隔离式克隆）与 `prompt_wav_path + prompt_text`（延续式克隆，全版本），与现有「角色 = 参考音」资产语义天然对齐。

同时 VoxCPM 与既有运行时**不可调和**：需要 `Python >=3.10`、`torch >=2.5.0`（当前 CosyVoice venv 固定 torch 2.3.1 / transformers 4.51.3，ASR venv 固定 transformers 4.57.6），且 `pip install voxcpm` 会拉入 gradio/funasr/datasets 等重依赖。**必须使用第三个专属 venv**，这是本方案沿用既有「专属 venv」模式的根本原因。

**目标**：在声音工坊增加 VoxCPM 作为**第二个本地 TTS 引擎家族**（可选 2 / 1.5 / 0.5B 三档版本），复用全部「引擎无关」设施——三步工作流、声音角色、ASR 回读验收、私有预览 / 显式入库、任务模型与历史。

**边界（本阶段不做）**：不做 VoxCPM 的 LoRA 微调 / vLLM 部署 / 流式逐字回调 UI；不做角色管线引擎解耦（角色仍由 CosyVoice 验收创建，VoxCPM 只读消费参考音，第二阶段解锁）；不做 30 语种的分语言回读阈值（Phase 1 回读仍只保证中英，见 §12）。

## 2. 产品决策：配音步骤引擎选择器 + 版本卡片

### 2.1 结论

**融合进现有的「配音」（synthesize）步骤**：步骤顶部增加**引擎选择器**（`CosyVoice2` / `VoxCPM`）。选择 VoxCPM 后展开**版本卡片**（`VoxCPM2` / `VoxCPM1.5` / `VoxCPM-0.5B`），每张卡片标注**参数档、体积、语种与克隆方式**，未下载的版本提供独立下载按钮；下载/环境安装过程经底部「执行日志」面板实时可见。不新增工作流步骤、不新建 Tab、不拆分 App。

### 2.2 论证

| 维度 | 融合（推荐） | 新建独立选项 |
|---|---|---|
| 用户心智 | 「文本 + 声音 → 音频」的产品意图相同，选引擎/版本只是选工具 | 两个入口做同一件事，增加导航噪音 |
| 声音角色复用 | 角色 = 参考音（CosyVoice 提示词），VoxCPM 只取参考音，零成本复用 | 角色无法跨入口复用 |
| 验收管道 | 回读验收（ASR 保真度 ≥0.85）引擎无关，一套实现覆盖 | 需要为第二个入口重复整套验收 |
| 历史/保存/草稿 | `audio_syntheses` 记录加 `engine` 列即可，一个历史、一个保存按钮 | 两套历史、两套保存流 |
| 任务模型 | `synthesize` action 不变，engine 只是参数 | 新增 action 类型与状态机分支 |
| 复杂度控制 | 复杂度收敛在「引擎 + 版本参数面板」这一处 | 复杂度扩散到导航、状态、契约多处 |

**代价**：配音参数面板需要按引擎分支渲染（CosyVoice 显示风格 4 选；VoxCPM 显示版本卡片 + 体积 + 克隆方式说明）。这是可控的、单点的复杂度。

### 2.3 已评估并被否决的替代

- **新建第 4 个工作流步骤「VoxCPM 配音」**：与「配音」步骤职责重叠；历史/验收/保存全部需要第二套。否决。
- **独立 App（新 manifest）**：角色、回读验收、任务模型、素材库保存全部分裂。否决。
- **直接替换 CosyVoice**：VoxCPM2 模型 5GB、重依赖多、MPS 性能受限；CosyVoice 轻量路径对低配用户仍有价值。否决。缺省引擎保持 CosyVoice。
- **只接 VoxCPM2 单版本**：用户明确要求多版本可选（2 / 1.5 / 0.5B 覆盖「质量」「轻量」「兼容老硬件」三档，且体积 5GB/2GB/1.6GB 差异显著），三档都接。

## 3. 关键不变量

1. **引擎无关设施不复刻**：三步工作流、角色复用、回读验收、私有预览/显式入库、任务模型、草稿持久化——全部共用一套，引擎只影响合成执行与参数面板。
2. **运行时彻底隔离**：VoxCPM 使用独立 `-voxcpm` venv 与独立 `voxcpm.requirements.lock`（Python >=3.10、torch >=2.5），不与 ASR venv、CosyVoice venv 混装；安装后必须 `pip check` + worker 版本自检。
3. **验收纪律不放松**：任何引擎/版本的输出都必须经 Qwen3-ASR 0.6B 回读，文本保真度 ≥ 0.85（多语言阈值见 §12）才暴露 WAV；未通过即删除，不进入历史与素材库。
4. **旧行为不回归**：未选择 VoxCPM 时，CosyVoice 引擎的合成、角色、历史与 UI 行为完全不变；`audio.synthesize` 缺省 `engine="cosyvoice2"`。
5. **角色是引擎无关资产**：角色记录只描述「参考音 + 可选提示词」，不绑定合成引擎；VoxCPM 只消费 `sample_path`（与 `prompt_text`，1.5/0.5B 延续式克隆需要）。
6. **参考音约束对齐引擎**：VoxCPM 官方要求 prompt 参考音与文本逐字对应（延续式克隆）。现有角色样本由 VoiceCloneEngine 裁剪并转写，`prompt_text` 即参考音转写，天然满足。

## 4. VoxCPM 版本与能力盘点（上游事实）

### 4.1 版本表（2026-08 实测 HF API 体积）

| 版本 | 标识 | 参数 | 采样率 | 语种 | 克隆方式 | 权重体积（HF 实测） | 状态 |
|---|---|---|---|---|---|---|---|
| VoxCPM2 | `voxcpm2` | 2B | 48kHz | 30 | 隔离式 `reference_wav_path` / 延续式 / Voice Design | **约 5.0 GB**（model.safetensors 4.58GB + audiovae.pth 0.38GB） | 最新（推荐） |
| VoxCPM1.5 | `voxcpm1.5` | 0.8B | 44.1kHz | zh/en | 延续式 `prompt_wav_path + prompt_text` | **约 2.0 GB**（model.safetensors 1.6GB + audiovae.pth 0.35GB） | 稳定 |
| VoxCPM-0.5B | `voxcpm-0.5b` | 0.5B | 16kHz | zh/en | 延续式 `prompt_wav_path + prompt_text` | **约 1.6 GB**（pytorch_model.bin 1.3GB + audiovae.pth 0.3GB） | 旧版/轻量 |

HF 仓库：`openbmb/VoxCPM2`、`openbmb/VoxCPM1.5`、`openbmb/VoxCPM-0.5B`；ModelScope：`OpenBMB/VoxCPM2` 等。

### 4.2 包与运行时约束

- `pip install voxcpm`（2.0.3）：`requires-python >=3.10`，`torch>=2.5.0`、`torchaudio>=2.5.0`、`torchcodec`、`transformers>=4.36.2`、`einops`、`gradio<7,>=6`、`funasr`、`datasets<4,>=3`、`modelscope>=1.22.0`、`librosa`、`soundfile`、`safetensors`、`wetext` 等。
- 运行时设备：`VoxCPM.from_pretrained(model_dir, load_denoiser=False, optimize=False, device=None)`；`device=None` 自动 CUDA → MPS → CPU。**关闭 `optimize`** 避免 torch.compile 预热（MPS 上不受支持），**关闭 denoiser** 避免拉取 ModelScope 降噪器。
- `model.generate(text, reference_wav_path=…, prompt_wav_path=…, prompt_text=…, cfg_value=2.0, inference_timesteps=10, seed=…)` → 1D float32 ndarray，采样率 `model.tts_model.sample_rate`。
- `reference_wav_path` **仅 VoxCPM2 支持**；`prompt_wav_path` 与 `prompt_text` 必须成对；Voice Design = `text` 加 `(描述)` 前缀（VoxCPM2）。

### 4.3 许可证

Apache-2.0，商用友好；权重与代码同许可证。无 IndexTTS 的 bilibili 协议风险。

## 5. 决策记录

| # | 决策 |
|---|---|
| D1 | **产品形态：融合进配音步骤**，顶部加引擎选择器（CosyVoice2 / VoxCPM），VoxCPM 下加版本卡片（2 / 1.5 / 0.5B）。 |
| D2 | **三档版本全接**：`voxcpm2` / `voxcpm1.5` / `voxcpm-0.5b`，体积分别约 5.0 / 2.0 / 1.6 GB，UI 明示体积与语种/克隆差异。 |
| D3 | **第三个专属 venv `-voxcpm`**：与 ASR、CosyVoice venv 彻底隔离；`voxcpm.requirements.lock` 先固定 `voxcpm==2.0.3` 为受管闭包（pip 解析传递依赖，后续按平台补全冻结）；安装后 `pip check` + worker 自检。 |
| D4 | **新增 `python/voxcpm_runner.py` worker**，命令 `status` / `synthesize`，镜像 `tts_runner.py` 的单行 JSON 输出与日志约定；由 `audio_runner` 按 engine 分派。 |
| D5 | **`audio.synthesize` 保持单一 op，扩展 `engine`**（`cosyvoice2` / `voxcpm2` / `voxcpm1.5` / `voxcpm-0.5b`，缺省 `cosyvoice2`）；`audio.install` 枚举加三个 voxcpm 版本；`audio.status` 的 `tts` 扩展 `engines.voxcpm` 结构，同时保留 `tts.ready` 向后兼容。 |
| D6 | **记录层加 `engine` 列**：`audio_syntheses` 加 `engine`（缺省 `cosyvoice2`）；历史/保存/预览引擎感知但不分裂。 |
| D7 | **默认音策略按版本**：VoxCPM2 用 Voice Design 固定描述作为默认音（无需参考音）；VoxCPM1.5 / 0.5B 无默认音，必须选择声音角色（延续式克隆需要参考音+转写）。 |
| D8 | **合成可观测性**：VoxCPM worker 模型加载/推理沿用实时日志 + 8 秒心跳；ASR 回读只在完整 WAV 写出后执行一次。 |
| D9 | **venv 安装过程日志可见**：`bootstrap.py` 在 `prepare` 中**尽力**创建 `-voxcpm` venv 并安装依赖，流式输出到执行日志；失败不阻断 prepare，由 `audio.status` 上报 `engines.voxcpm.runtime=false` 与错误，UI 给出「重试安装运行环境」引导；`audio.install` 下载任一 voxcpm 版本前先幂等确保运行环境（重试路径），失败则任务失败并暴露日志。 |
| D10 | **懒加载权重**：模型权重只在用户点击对应版本下载时安装，不并入默认 `prepare`；未使用 VoxCPM 的用户安装足迹不增长（仅 prepare 的 venv 依赖）。 |

## 6. 架构总览

```text
ui/ 配音步骤
  ├─ 引擎选择器：CosyVoice2 / VoxCPM ──┐（切换下方参数面板）
  ├─ 共用：文本 / 声音角色列表 / 生成按钮 / 历史 / 预览 / 保存
  ├─ CosyVoice 面板：风格 4 选（现状不变）
  └─ VoxCPM 面板：版本卡片（2 / 1.5 / 0.5B）× 体积 × 状态 × 下载
        │ recut.background audio.synthesize { engine, text, characterId? }
        ▼
background.js
  ├─ engine 校验 → ctx.python.run(audio_runner.py synthesize --engine ...)
  ├─ audio_syntheses 插入 engine 列
  └─ 任务模型 / 历史 / save 全复用（engine 仅记录维度）
        ▼
audio_runner.py（主 ASR venv）
  ├─ 校验 engine 运行时就绪 + Qwen3-ASR 0.6B 可回读
  ├─ cosyvoice2 ──► tts_runner.py（-cosyvoice venv，现状不动）
  └─ voxcpm*  ──► voxcpm_runner.py（-voxcpm venv，torch>=2.5）
        │ 合成 WAV → 单次 Qwen3-ASR 回读（fidelity ≥ 0.85）→ meta.json
        ▼
~/.recut/models/audio-studio/
  ├─ cosyvoice/   （现状）
  └─ voxcpm/
      ├─ voxcpm2/      约 5.0 GB
      ├─ voxcpm1.5/    约 2.0 GB
      └─ voxcpm-0.5b/  约 1.6 GB
```

数据流：**引擎/版本选择 → 统一 synthesize op → 按引擎分派 worker → 统一回读验收 → 统一历史/预览/保存**。引擎差异只发生在「参数面板渲染」与「worker 执行」两处。

## 7. 引擎与运行环境

### 7.1 Bootstrap（`bootstrap.py`）

- 新增 `ensure_voxcpm_runtime()`（幂等）：以 `RECUT_PYTHON` 为基解释器创建 `-voxcpm` venv，`pip install --requirement python/voxcpm.requirements.lock`，随后 `pip check` 与 `voxcpm_runner.py status` 自检。
- `main()` 中 **在 CosyVoice 之后调用**，但用 `try/except` 包裹：失败打印醒目警告（含错误）**不抛出**，保证 `audio.prepare` 不因 VoxCPM 可选引擎失败而整体失败；状态由 `audio.status` 的 `engines.voxcpm.runtime` 暴露。
- `audio.install { model: voxcpm* }` 前置调用 `bootstrap.py --voxcpm-only`（子进程，stdout 直通），把 venv 创建/依赖安装过程原样流到任务日志。

### 7.2 `voxcpm.requirements.lock`

- 固定 `voxcpm==2.0.3`；上游声明的 torch>=2.5.0、torchaudio>=2.5.0、torchcodec、transformers>=4.36.2 等由 pip 解析到满足全部约束的版本。
- 头部注明：这是**受管闭包锁**（非完整 freeze），安装后由 `pip check` + worker 版本自检兜底；待各目标平台首装验证后再按平台补全冻结版本。

### 7.3 Install 目标（`audio.install`）

- `model` 枚举新增 `voxcpm2` / `voxcpm1.5` / `voxcpm-0.5b`：先 `ensure_voxcpm_runtime()`（幂等，日志可见），再 `download_repo` 到 `~/.recut/models/audio-studio/voxcpm/<version>/`（沿用 automatic/huggingface/modelscope）。
- 下载前打印该版本体积提示（约 5.0 / 2.0 / 1.6 GB）；安装完成打印磁盘提示。

### 7.4 Worker（`python/voxcpm_runner.py`，新增）

镜像 `tts_runner.py` 契约：持续输出阶段日志，末行单行 JSON `{ready, duration, sampleRate, ...}`。

```text
status
  - 校验 Python >=3.10、torch >=2.5.0、import voxcpm、find_spec 关键模块
  - 返回 { ready, versions, error }

synthesize --version voxcpm2|voxcpm1.5|voxcpm-0.5b --model-dir DIR
           [--reference WAV] [--prompt-text TEXT] [--voice-design] --text TEXT --output WAV
  - VoxCPM.from_pretrained(DIR, load_denoiser=False, optimize=False, device=None)
  - voxcpm2 + reference   → reference_wav_path=reference
  - voxcpm2 + voice-design→ text = f"({VOXCPM_DESIGN_DESC}){text}"
  - voxcpm1.5/0.5b + ref  → prompt_wav_path=reference, prompt_text=prompt-text（延续式克隆）
  - 无 reference 且非 voice-design → 报错并提示需声音角色
  - model.generate(text, cfg_value=2.0, inference_timesteps=10, seed=42)
  - 波形质量检查（finite + peak）→ sf.write（model.tts_model.sample_rate 采样率单声道 PCM_16）
```

### 7.5 `audio_runner.py` 分派

- `run_tts_worker(engine, args)`：`cosyvoice2` → `-cosyvoice` venv python + `tts_runner.py`；`voxcpm*` → `-voxcpm` venv python + `voxcpm_runner.py`。共用心跳中继与 `parse_worker_result`。
- `state()` 的 `tts` 增加 `engines.voxcpm`（§8.3），`tts.ready` 保持 CosyVoice 语义向后兼容。
- `synthesize()` 按 engine 分支：CosyVoice 路径保持现状；VoxCPM 路径校验运行时 + 版本权重已下载 + 参考音可用（或 VoxCPM2 默认音走 voice-design），把 engine/version 透传 worker，写 `meta.json` 时记录 `engine`。

## 8. 数据与接口契约

### 8.1 Manifest / 后台操作

**`audio.install`**（`inputSchema.model` 枚举）加 `"voxcpm2"` / `"voxcpm1.5"` / `"voxcpm-0.5b"`。

**`audio.synthesize`**（保持单一 op，`inputSchema` 扩展）：

```text
required: ["text"]
properties:
  text:        string
  engine:      enum ["cosyvoice2","voxcpm2","voxcpm1.5","voxcpm-0.5b"]   default "cosyvoice2"
  characterId: string   optional（voxcpm1.5/voxcpm-0.5b 必填；voxcpm2 可省略走 Voice Design 默认音）
  style:       enum ["neutral","calm","excited","gentle"]  optional（仅 cosyvoice2）
```

校验：`engine` 与参数强绑定（`voxcpm1.5`/`voxcpm-0.5b` 无默认音，缺 characterId 报错并给出引导文案）。

**`audio.status`**：`tts` 结构扩展，同时保留向后兼容字段：

```jsonc
"tts": {
  "ready": true,                 // 任一引擎就绪 && 回读器就绪（向后兼容）
  "verification": true,
  "engines": {
    "cosyvoice2": { "repository": true, "model": true, "runtime": true, "ready": true },
    "voxcpm": {
      "runtime": true,
      "runtimeError": null,
      "models": {
        "voxcpm2":     { "downloaded": true,  "ready": true,  "sizeGb": 5.0 },
        "voxcpm1.5":   { "downloaded": false, "ready": false, "sizeGb": 2.0 },
        "voxcpm-0.5b": { "downloaded": false, "ready": false, "sizeGb": 1.6 }
      },
      "ready": true
    }
  }
}
```

**`audio.synthesis.complete` / `audio.syntheses`**：返回记录新增 `engine`，供历史卡与预览展示引擎徽标。

### 8.2 SQLite

```sql
-- audio_syntheses 增加一列（ensureColumn 幂等迁移）
alter table audio_syntheses add column engine text not null default 'cosyvoice2';
```

- `engine` 是记录维度，不参与 `synthesize` 任务模型的 action（仍为 `"synthesize"`）。

### 8.3 UI 类型（`types.ts`）

```ts
export type TtsEngine = "cosyvoice2" | "voxcpm2" | "voxcpm1.5" | "voxcpm-0.5b";
export type VoxCpmVersion = "voxcpm2" | "voxcpm1.5" | "voxcpm-0.5b";
// RuntimeStatus.tts.engines.voxcpm 结构 + Synthesis 加 engine
```

## 9. UI 参数设计

### 9.1 布局（配音步骤）

```text
┌ 要朗读的内容 ─────────────────────────────┐
│ [textarea]                                │
├ 引擎 ─────────────────────────────────────┤
│ (●) CosyVoice2  (○) VoxCPM               │   ← 引擎选择器
│   CosyVoice2：轻量 · 中英 · 默认          │
│   VoxCPM：多版本可选 · 克隆 · 30 语种     │
├ 声音（角色列表，与引擎共用）────────────────┤
│ (○) 默认音[仅 CosyVoice2 / VoxCPM2]      │
│ (角色卡片… 选中高亮；VoxCPM1.5/0.5B 必选)  │
├ 引擎参数面板（随引擎切换）──────────────────┤
│ CosyVoice2 → 情绪指令 4 选（现状不变）      │
│ VoxCPM →
│   VoxCPM 版本 [VoxCPM2 · 2B · 48kHz · 30 语种 · 约 5.0 GB ▾]
│              VoxCPM1.5 · 0.8B · 44.1kHz · 中英 · 约 2.0 GB
│              VoxCPM-0.5B · 0.5B · 16kHz · 中英 · 约 1.6 GB
│   所选版本状态行：[✓ VoxCPM2 已就绪] 或 [下载权重（约 5.0 GB）]
│   · VoxCPM 运行环境未就绪 → [安装 VoxCPM 运行环境]（引导，日志可见）
│   · 提示：VoxCPM 输出 30 语种，但回读验收目前只保证中英
├ 就绪区 ────────────────────────────────────┤
│ ✓ 所选引擎已就绪                          │
└───────────────────────────────────────────┘
```

> 注：2026-08-22 评审后将「版本卡片列表」收敛为「版本下拉 + 单行状态」，避免占纵向空间；下拉项内仍标注档位/采样率/语种与体积。

### 9.2 交互规则

- **引擎切换**：切换保留文本与角色列表（跨引擎共享）；VoxCPM 下「默认音」仅 VoxCPM2 可用（Voice Design），1.5/0.5B 未选角色时生成按钮禁用并提示「该版本需要声音角色」。
- **就绪门控**：`synthesize` 主按钮需要 `text 非空 && 所选引擎/版本 ready && 回读器 ready`。CosyVoice 与 VoxCPM 各自独立下载按钮。
- **版本下拉**：选择器内每项标注版本/档位/采样率/语种/体积；所选版本下方单行状态行显示「已就绪」或「下载权重（约 x GB）」，运行环境未就绪时显示琥珀色引导框。
- **历史卡**：合成卡片加引擎徽标（CosyVoice2 / VoxCPM2 / VoxCPM1.5 / VoxCPM-0.5B）。
- **草稿**：v1 键不变，`engine` 字段可选读取（无则 cosyvoice2），重启后恢复。

### 9.3 i18n 新增（`i18n.ts` zh/en 双语言）

引擎标签与 note、VoxCPM 三版本标签（参数/采样率/语种/体积）、下载与就绪按钮、运行环境未就绪引导、克隆方式说明、30 语种验收提示、历史引擎徽标。

## 10. 分阶段实施

**Phase 0 —— 依赖与运行时（可独立验收）**
1. `bootstrap.py` 增加 `ensure_voxcpm_runtime()`（幂等、`--voxcpm-only` 入口、失败不阻断 prepare）+ `voxcpm.requirements.lock`；`pip check` + `voxcpm_runner.py status` 自检。
2. `python/voxcpm_runner.py` 实现 `status` / `synthesize`（版本分派、voice-design、心跳日志）。
3. `audio_runner.py`：`install` 增加三档 voxcpm 目标（先 ensure runtime 再下载权重）；`state()` 增加 `engines.voxcpm`；`run_tts_worker` 引擎分派。
4. 手工脚本级验证：对固定文本用各版本默认音/角色音直接跑通合成 + 回读验收，记录时长/内存/质量基线。

**Phase 1 —— 后端契约**
5. `manifest.json`：`audio.install` 枚举加三档；`audio.synthesize` inputSchema 扩展 engine；`audio.status` 文档同步。
6. `background.js`：`synthesize()` 解析 engine 参数并强校验；`audio_syntheses` 加列（ensureColumn）；`synthesis.complete/syntheses` 返回 engine。
7. `skills/audio-studio/SKILL.md` 与 `README.md` 更新多引擎说明与验收不变纪律。

**Phase 2 —— UI 落地**
8. `types.ts` 加 TtsEngine/VoxCpmVersion 等类型；`i18n.ts` 全量新增文案（§9.3）。
9. `main.tsx`：引擎选择器 + VoxCPM 版本卡片（体积/状态/下载/环境引导）+ 历史引擎徽标 + 草稿兼容。

**Phase 3 —— 一致化与回归**
10. 新老项目兼容回归：CosyVoice 引擎行为、旧历史卡展示、旧草稿迁移。
11. `README.md`、`SKILL.md`、`manifest.json` 反向更新；端到端验证（§11）。

## 11. 测试与验证

沿用音频工坊既有分层设施，不引入新框架：

- **L1 后台/worker（脚本级 hermetic）**：
  - `voxcpm_runner.py status` 在完整/缺 venv/缺包三种环境下返回正确 ready 与 error。
  - `synthesize` 三版本 ×（默认音[voxcpm2 voice-design] / 角色音[reference 或 prompt]）按 fixture 文本出 WAV；无参考音且非 voice-design 时给出明确前置错误。
  - `audio_runner.install voxcpm*` 幂等、体积提示落盘；断网回退 ModelScope。
  - `background.synthesize`：engine 强校验、engine 列落库、历史返回 engine。
- **L2 UI（手动验收）**：引擎选择器切换正确显隐面板；版本卡片体积/状态/下载按钮独立就绪；运行环境未就绪时出现引导按钮；日志面板展示 venv 安装过程；历史卡引擎徽标；草稿恢复。
- **L3 端到端（真实 service + app）**：固定文本经各版本合成 → Qwen3-ASR 回读保真度达标 → 预览可播 → 显式入库产生 Asset；与 CosyVoice 同文本并行跑回归。

**命令**：L1 直接 `python/audio_runner.py ...` 与两个 venv 的 runner；L3 需 `make dev` 全链路。

## 12. 风险与取舍 / 开放问题

- **风险 1（重依赖与磁盘）**：`pip install voxcpm` 会拉入 gradio/funasr/datasets 等，venv 体积大、首装耗时长；模型 5GB（VoxCPM2）。对策：运行时在 prepare 中尽力安装（失败不阻断）、下载前体积提示、安装过程日志可见、心跳约定；不做常驻服务。
- **风险 2（MPS 性能）**：VoxCPM2 2B 模型在 Apple Silicon MPS 上为社区级支持，性能与内存受限（参考 IndexTTS RFC 风险 1）。对策：保留 CosyVoice 为默认引擎；版本卡片把 1.5/0.5B 作为轻量替代；`audio.status` 上报设备供面板提示。
- **风险 3（多语言回读阈值）**：Qwen3-ASR 0.6B 对非中英语言的保真度在 0.85 阈值下可能偏严。Phase 1 沿用 0.85 并把验收锁定在中英文本；UI 明示「回读验收目前只保证中英」。后续可按语言微调阈值。
- **风险 4（torchcodec / 平台 wheel）**：torchcodec 等新依赖在某些平台可能缺少 wheel 导致 venv 安装失败。对策：`pip check` + 自检兜底，失败在 status 暴露可读错误；锁文件留待按平台补全冻结。
- **开放问题 1（Voice Design 默认音）**：VoxCPM2 默认音用固定中文描述 + 固定 seed，可复现但非「官方默认人声」。备选：内置一段干净示例人声作默认参考音。倾向先 voice-design，后续可替换。
- **开放问题 2（角色管线引擎）**：Phase 1 角色仍由 CosyVoice 验收创建，VoxCPM 只读消费（1.5/0.5B 需要 prompt_text）。Phase 2 可把角色创建管线改为引擎可选，解锁「仅装 VoxCPM 也能建角色」。
- **取舍**：比「第三套 venv + 新 worker」多一份依赖维护成本，换来与 Qwen3-ASR、CosyVoice 的版本冲突彻底隔离，并可独立升级任一引擎；融合进配音步骤以参数面板单点复杂度换取全部产品流复用。

## 13. 验证验收清单（采纳后）

1. 配音步骤出现引擎选择器；未选 VoxCPM 时 CosyVoice 行为与 UI 完全不变。
2. `audio.install { model:"voxcpm2"|"voxcpm1.5"|"voxcpm-0.5b" }` 成功下载对应权重；`audio.status` 的 `engines.voxcpm.models.<version>.ready` 为 true。
3. 运行环境未就绪时，`audio.status` 的 `engines.voxcpm.runtime=false` 且带可读错误；UI 出现「安装 VoxCPM 运行环境」引导；安装日志在日志面板可见。
4. VoxCPM2 默认音（voice-design）与角色音（reference）各产出一条验收通过的 WAV；VoxCPM1.5 / 0.5B 用角色音（prompt 延续式）产出验收通过的 WAV。
5. 历史合成卡显示引擎徽标；旧记录（engine 默认 cosyvoice2）正常展示。
6. 任一引擎输出必须过 ASR 回读 ≥0.85 才可预览/保存；失败结果不进历史。
7. `make` 既有检查与 L1/L3 用例全绿。

## 14. 不采纳边界（明确不做）

- 不做 **LoRA 微调 / vLLM / llama.cpp-omni 部署**：保持本地自托管，走 `pip install voxcpm` 官方推理路径。
- 不做 **流式逐字回调 UI**：VoxCPM 有 `generate_streaming`，但本阶段统一走完整 WAV + 回读验收。
- 不做 **30 语种的分语言验收**：回读仍用 Qwen3-ASR 0.6B，中英以外不作为验收通过保证（见 §12 风险 3）。
- 不做 **角色管线引擎解耦**（Phase 2 事项，本阶段角色仍由 CosyVoice 验收创建）。
- 不做 **合成预览即自动入库**：输出仍先留私有区，用户确认后才进素材库（平台纪律）。
- 不做 **VoxCPM2 的 8 维情感向量 / 风格控制 UI**：`generate` 的 `cfg_value` 等保持服务端默认，UI 不暴露。