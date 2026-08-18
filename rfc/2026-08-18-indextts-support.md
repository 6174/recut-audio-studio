<!--
 * [INPUT]: 依赖 audio-studio 现状（background.js 的 audio.synthesize/character.create 与任务模型、audio_runner.py 的 CosyVoice 合成与 Qwen3-ASR 回读验收、bootstrap.py 的专属 TTS venv 隔离模式、ui 的三步工作流与配音控件）、
 *          以及 IndexTTS 上游能力（IndexTTS-2.5 的 infer_v2_5.py 构造/推理参数、webui.py 的 REQUIRED_FILES 与情感控制四种模式、pyproject.toml 的依赖闭包与 extras、参考音 15 秒截断约束、约 5.1GiB 模型体积）
 * [OUTPUT]: 定义声音工坊支持 IndexTTS-2.5 的整体方案：产品决策为「融入现有配音步骤 + 引擎选择器」而非新增独立工作流；
 *          新增与 ASR/CosyVoice 彻底隔离的第三个专属 venv 与 indextts_runner.py worker；manifest/background 的 engine+params 契约、
 *          audio_syntheses 记录加列、status 的 engines 结构、UI 的引擎选择 + 语言/语速/四模式情感控制/高级参数面板、
 *          角色管线引擎解耦（第二阶段）、以及分阶段实施与分层验证
 * [POS]: rfc 的 audio-studio 双引擎配音实施蓝图；获批后落到 manifest/background.js、audio_runner.py + indextts_runner.py、
 *        bootstrap.py + indextts.requirements.lock、ui/src/main.tsx + i18n.ts + types.ts，并反向更新 README 与 SKILL.md
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 -->

# RFC: 声音工坊支持 IndexTTS-2.5——融入配音步骤的第二个本地 TTS 引擎

- 状态：**搁置（暂不实施）**——MPS/CPU 设备性能与内存问题、5.1GiB 权重门槛使其暂不值得接入；方案保留备查，待硬件条件（CUDA GPU 用户群）或上游 MPS 支持成熟后再评审。
- 作者：Recut
- 日期：2026-08-18
- 决策范围：产品形态（融合 vs 新选项）、引擎/运行时隔离、Install 目标、operation 与数据契约、UI 参数映射、角色管线解耦、验收与验证、分阶段实施、不采纳边界
- 关联：`manifest.json`、`background.js`、`python/audio_runner.py`、`python/tts_runner.py`、`python/requirements.lock`、`python/cosyvoice.requirements.lock`、`bootstrap.py`、`skills/audio-studio/SKILL.md`、`ui/src/main.tsx`、`ui/src/types.ts`、`ui/src/i18n.ts`、`README.md`、上游 `github.com/index-tts/index-tts`（IndexTTS-2.5，2026-08-10 发布）

## 1. 背景与病灶

声音工坊（`apps/audio-studio`）目前只有**一条本地配音链路**：`audio.synthesize(text, characterId?, style)` → `audio_runner.synthesize()` → `tts_runner.py`（CosyVoice 专属 venv 内的 `CosyVoice2`）→ 写出 WAV → `Qwen3-ASR 0.6B 回读验收（保真度 ≥ 0.85）` → 私有预览 / 显式入库。声音角色由 `VoiceCloneEngine` 创建：预处理 → 选 3~6 秒连续人声 → 波形验收 → **CosyVoice 声纹验证** → ASR 生成提示词 → 「合成→回读」校准，全部通过才能进入 TTS。

对照上游 [index-tts/index-tts](https://github.com/index-tts/index-tts)，最新 **IndexTTS-2.5**（0.8B，2026-08-10 发布）在四个维度显著补足当前产品缺口：

1. **多语言**：中文 / 英文 / 日文 / 西班牙语 / 阿拉伯语（`lang` 参数），且支持跨语种克隆（中文参考音 → 目标语言朗读）。CosyVoice2 只做中英。
2. **可控情感**：四种情感控制模式（同音色参考 / 独立情感参考音 / 8 维情感向量 / 情感描述文本），配 `emo_alpha` 强度与 `use_random` 随机性。当前 CosyVoice 的 `style`（中性/平静/兴奋/温柔）在实现上**只记录进 meta.json、并未真正影响输出**，是一个「有名无实」的控件——IndexTTS 能提供真实可闻的情感控制。
3. **语速控制**：`duration_factor`（0.5–2.0，>1 放慢、<1 加速）。
4. **发音控制**：文本内联注音（拼音 `<行|XING2>` / CMU 音标 `<minute|M IH1 . N AH0 T>` / 日文假名 `<上手|じょうず>`），对多音字/术语/外来词有确定性纠正能力。

同时 IndexTTS 与 CosyVoice 存在**不可调和的运行时差异**：IndexTTS 需要 Python `>=3.10,<3.12`、torch `2.8.*`、transformers `4.52.1`、numpy `2.2.6`，而当前 ASR venv（Qwen3-ASR）需要 transformers `4.57.6`、CosyVoice venv 需要 torch `2.3.1` / transformers `4.51.3`。**三者必须各自隔离**，这是本方案沿用既有「专属 venv」模式的根本原因。

**目标**：在声音工坊增加 IndexTTS-2.5 作为**第二个本地 TTS 引擎**，复用全部「引擎无关」设施——三步工作流、声音角色、ASR 回读验收、私有预览 / 显式入库、任务模型与历史。

**边界（本阶段不做）**：不引入 IndexTTS-2 / 1.5 等旧版；不做云端 TTS 或 vLLM 部署；不做语速/情感参数的自动推荐或与转写联动；不改变 CosyVoice 引擎本身的既有行为。

## 2. 产品决策：融合进配音步骤，而非新建独立选项

### 2.1 结论

**融合进现有的「配音」（synthesize）步骤**，在该步骤顶部增加**引擎选择器**（`CosyVoice2` / `IndexTTS-2.5`），引擎选择驱动下方参数面板切换。不新增第 4 个工作流步骤，不新建独立 Tab，不拆分独立 App。

### 2.2 论证

| 维度 | 融合（推荐） | 新建独立选项 |
|---|---|---|
| 用户心智 | 「文本 + 声音 → 音频」的产品意图相同，选引擎只是选工具 | 两个入口做同一件事，增加导航噪音 |
| 声音角色复用 | 角色 = 参考音（+ CosyVoice 提示词），IndexTTS 只需参考音即可零成本复用 | 角色无法跨入口复用，或被迫复制一套角色管线 |
| 验收管道 | 回读验收（ASR 保真度 ≥0.85）、WAV 质量检查引擎无关，一套实现覆盖 | 需要为第二个入口重复整套验收 |
| 历史/保存/草稿 | `audio_syntheses` 记录加 `engine` 列即可，一个历史、一个保存按钮 | 两套历史、两套草稿、两套保存流 |
| 任务模型 | `synthesize` action 不变，engine 只是参数 | 新增 action 类型与状态机分支 |
| 复杂度控制 | 复杂度收敛在「引擎参数面板」这一处 | 复杂度扩散到导航、状态、契约多处 |

**代价**：配音参数面板需要按引擎分支渲染（CosyVoice 显示风格 4 选；IndexTTS 显示语言 / 语速 / 情感面板 / 高级参数），工作台 UI 组件会变大。这是可控的、单点的复杂度，用「引擎选择器 + 条件渲染」解决，不扩散到数据模型与后端。

### 2.3 已评估并被否决的替代

- **新建第 4 个工作流步骤「IndexTTS 配音」**：与「配音」步骤职责重叠；3 步导航（转写 → 角色 → 配音）失去语义唯一性；历史/验收/保存全部需要第二套或做引擎感知。否决。
- **独立 App（新 manifest）**：角色、回读验收、任务模型、素材库保存全部分裂；且 IndexTTS 与 CosyVoice 共享同一声纹参考音与素材语义，分 App 是产品割裂。否决。
- **直接替换 CosyVoice**：IndexTTS 模型 5.1GiB、强依赖 GPU，且 CosyVoice 轻量路径（2.7GiB）对低配用户仍有价值；缺省引擎仍保留 CosyVoice 保持现有行为不回归。否决。

## 3. 关键不变量

1. **引擎无关设施不复刻**：三步工作流、角色复用、回读验收、私有预览/显式入库、任务模型、草稿持久化——全部共用一套，引擎只影响合成执行与参数面板。
2. **运行时彻底隔离**：IndexTTS 使用独立 `-indextts` venv 与独立 lockfile（torch 2.8 / transformers 4.52.1 / numpy 2.2.6），不与 ASR venv、CosyVoice venv 混装；安装后必须 `pip check` + worker 版本自检。
3. **验收纪律不放松**：任何引擎的输出都必须经 Qwen3-ASR 0.6B 回读，文本保真度 ≥ 0.85（多语言阈值见 §12 风险）才暴露 WAV；未通过即删除，不进入历史与素材库。
4. **旧行为不回归**：未选择 IndexTTS 时，CosyVoice 引擎的合成、角色、历史与 UI 行为完全不变；`audio.synthesize` 缺省 `engine="cosyvoice2"`。
5. **角色是引擎无关资产**：角色记录只描述「参考音 + 可选提示词」，不绑定合成引擎；任何已验收角色都可被任一引擎消费（IndexTTS 只用参考音，忽略提示词）。
6. **参考音约束对齐引擎**：IndexTTS 官方将参考音截断到 **15 秒**（超出静默截断，无最短要求）；CosyVoice 角色样本 3~6 秒天然满足，无需改动。

## 4. IndexTTS 能力与参数盘点（上游事实）

### 4.1 构造参数（`IndexTTS2`，`indextts/infer_v2_5.py`）

| 参数 | 默认 | 说明 | 本方案处理 |
|---|---|---|---|
| `model_dir` / `cfg_path` | `checkpoints` / `config.yaml` | 模型目录与配置（`config.yaml` 由官方 `ensure_config_available` 独立下载） | 统一下载到 `~/.recut/models/audio-studio/indextts/IndexTTS-2.5/` |
| `use_bf16` | `False` | 半精度推理（仅 CUDA/XPU 生效；CPU/MPS 强制 False） | 加载时按设备自动：CUDA 支持 bf16 则 True，否则 False |
| `use_cuda_kernel` | `None` | BigVGAN 融合 CUDA 内核，失败自动回退 | 固定 `False`（省去构建风险），Phase 3 可作高级项 |
| `use_deepspeed` | `False` | DeepSpeed 加速，可能反而变慢 | 不启用 |
| `use_accel` | `False` | flash-attn GPT2 引擎 | 不启用 |
| `use_torch_compile` | `False` | s2mel 的 triton 编译 | 不启用 |
| `use_qwen_emo` | `False` | 是否加载 QwenEmotion（约 1.2GiB）。**情感描述文本模式必须为 True**，否则 `RuntimeError` | 仅当本次合成选择「情感描述文本」模式时传 True；未选则不加载，节省显存 |
| `device` | 自动 | cuda → xpu → mps → cpu | 跟随官方自动选择；**CUDA 为推荐，CPU 不实用（见 §12）** |

### 4.2 `infer()` 推理参数（2.5）

| 参数 | 默认 | 范围/说明 | UI 映射 |
|---|---|---|---|
| `spk_audio_prompt` | 必填 | 音色参考音，librosa 可读即可；**截断到 15 秒**，无最短限制 | 角色样本 wav / 内置默认音 |
| `text` | 必填 | 目标文本 | 文本框（与 CosyVoice 共用） |
| `lang` | 必填 | `ZH/EN/JA/AR/ES`（官方 WebUI 枚举）；内部还支持更多语种 token | 下拉（见 §8.2） |
| `emo_audio_prompt` | `None` | 独立情感参考音（15 秒截断）；为 None 时回退 `spk_audio_prompt` 且 `emo_alpha` 强制 1.0 | 情感模式「参考音」→ 素材库选第二个音频 |
| `emo_alpha` | `1.0` | 情感强度 0~1 | 滑块（默认 0.65；文本模式建议 0.6） |
| `emo_vector` | `None` | 8 维情感向量 `[喜,怒,哀,惧,厌恶,低落,惊喜,平静]`，需先经 `normalize_emo_vec(apply_bias=True)` | 8 个滑块 + 强度滑块 |
| `use_emo_text` | `False` | 由文本转情感向量；`emo_text=None` 时用 `text` 本身 | 情感模式「描述文本」→ 开关 |
| `emo_text` | `None` | 情感描述文本（如「委屈巴巴」） | 文本框 |
| `use_random` | `False` | 情感随机采样（降低克隆保真度） | 复选框 |
| `duration_factor` | `1.0` | 语速/时长系数 0.5~2.0（>1 放慢、<1 加速） | 滑块 |
| `max_text_tokens_per_segment` | `120` | 分句最大 token，建议 80~200 | 高级参数 |
| `do_sample` / `top_p` / `top_k` / `temperature` / `length_penalty` / `num_beams` / `repetition_penalty` / `max_mel_tokens` | `True` / `0.8` / `30` / `0.8` / `0.0` / `3` / `10.0` / `1500` | GPT2 采样参数 | 仅暴露 `temperature`/`top_p`/`repetition_penalty`/`max_mel_tokens` 于高级面板，其余服务端固定默认 |

**输出**：单声道 22050 Hz WAV。

### 4.3 情感控制四种模式（产品映射核心）

| 模式 | 上游实现 | 我们的 UI |
|---|---|---|
| 0 与音色参考音频相同 | `emo_audio_prompt=None, emo_vector=None, use_emo_text=False` → 回退 spk | 默认单选，无额外参数（等价 CosyVoice 中性） |
| 1 使用情感参考音频 | `emo_audio_prompt=path, emo_alpha` | 单选 + 「选择情感参考音频」素材选择器 |
| 2 使用情感向量控制 | `emo_vector=normalize_emo_vec(vec, apply_bias=True), emo_alpha, use_random` | 单选 + 8 滑块 + 强度滑块 + 随机复选框 |
| 3 使用情感描述文本控制 | `use_emo_text=True, emo_text, emo_alpha, use_random`（**需 QwenEmotion**，实验性） | 单选 + 描述文本框 + 强度滑块 + 随机复选框 + 实验性提示 |

### 4.4 发音控制（无需 UI 参数）

IndexTTS-2.5 在**文本内**支持注音标注：拼音 `<行|XING2>`、CMU 音标 `<minute|M IH1 . N AH0 T>`、日文假名 `<上手|じょうず>`。因此不需要独立参数控件，只需在文本框下方给出提示文案。拼音合法集合见模型目录 `pinyin.vocab`。

### 4.5 模型文件与体积（2.5）

`webui.py` 的 `REQUIRED_FILES["2.5"]`：`gpt.pth`(~3.26GiB)、`codec.pth`(~607MiB)、`s2mel.pth`(~415MiB)、`multilingual_zh_ja_yue_char_del.tiktoken`、`wav2vec2bert_stats.pt`；另需 `config.yaml`（独立下载）与配置引用的 `feat1.pt`/`feat2.pt`/`qwen0.6bemo4-merge`（约 1.2GiB）。**整仓约 5.1GiB**。首次加载还会在 `model_dir/hf_cache` 自动补齐 `w2v-bert-2.0` 与 `campplus_cn_common.bin` 等辅助权重。

**许可证风险**：IndexTTS 采用 **bilibili Model Use License Agreement**（非 Apache），商用需联系 bilibili。用户自托管模型 + Recut 提供管道，需在产品内明确展示许可证（见 §12）。

## 5. 决策记录

| # | 决策 |
|---|---|
| D1 | **产品形态：融合进配音步骤**，顶部加引擎选择器（CosyVoice2 / IndexTTS-2.5），不新增工作流步骤/Tab/App。 |
| D2 | **只支持 IndexTTS-2.5**（`lang` 五语种、语速、发音控制、情感四模式），不引入 2 / 1.5。 |
| D3 | **第三个专属 venv `-indextts`**：与 ASR、CosyVoice venv 彻底隔离，`indextts.requirements.lock` 固定 torch 2.8.* / transformers 4.52.1 / numpy 2.2.6 等完整闭包；bootstrap 固定 index-tts 源码 revision，安装后 `pip check` + worker 自检。 |
| D4 | **新增 `python/indextts_runner.py` worker**，命令 `status` / `synthesize`，镜像 `tts_runner.py` 的单行 JSON 输出与心跳约定；由 `audio_runner` 按 engine 分派。 |
| D5 | **`audio.synthesize` 保持单一 op，扩展 engine + 参数**；`audio.install` 枚举加 `indextts25`；`audio.status` 的 `tts` 改为 `engines` 结构，同时保留 `tts.ready` 向后兼容。 |
| D6 | **记录层加 `engine` 列与 `params_json`**：`audio_syntheses` 加 `engine`、`params_json`；历史/保存/草稿全部引擎感知但不分裂。 |
| D7 | **情感参数默认跟随官方 WebUI**：`emo_alpha` 0.65（文本模式 0.6）、8 维向量默认全 0、`use_random` 默认关；高级采样参数服务端默认值与官方一致，UI 只暴露子集。 |
| D8 | **角色在 Phase 1 保持 CosyVoice 验收、IndexTTS 只读消费**（IndexTTS 只需参考音）；Phase 2 把角色创建管线改为引擎可选，解锁「仅装 IndexTTS 也能建角色」。 |
| D9 | **IndexTTS 默认音**：安装 `indextts25` 时把模型仓库随附的干净示例人声（`examples/voice_01.wav`，与模型同许可证）复制为 `default_voice.wav`；IndexTTS 不需要参考音转写，故无提示词依赖。 |
| D10 | **合成可观测性**：IndexTTS 模型加载/推理分片/写出沿用实时日志 + 8 秒心跳，与 CosyVoice 一致；ASR 回读只在完整 WAV 写出后执行一次。 |
| D11 | **懒加载 / 按需安装（降门槛）**：IndexTTS 的 venv、源码与权重只在用户点击下载时安装，不并入默认 `prepare`；不使用的用户安装足迹零增长。 |

## 6. 架构总览

```text
ui/ 配音步骤
  ├─ 引擎选择器：CosyVoice2 / IndexTTS-2.5 ──┐（切换下方参数面板）
  ├─ 共用：文本 / 声音角色列表 / 生成按钮 / 历史 / 预览 / 保存
  ├─ CosyVoice 面板：风格 4 选（现状不变）
  └─ IndexTTS 面板：语言 · 语速 · 情感模式(4) · 高级参数
        │ recut.background audio.synthesize { engine, text, characterId, lang,
        │   durationFactor, emotion:{mode,referenceAssetId?,vector?,emoText?,alpha,random},
        │   advanced?:{temperature,topP,repetitionPenalty,maxMelTokens} }
        ▼
background.js
  ├─ engine 分派 → ctx.python.run(audio_runner.py synthesize --engine ... --params-json ...)
  ├─ emotion.referenceAssetId → ctx.media.materialize → 私有参考音路径
  ├─ audio_syntheses 插入 engine + params_json
  └─ 任务模型 / 历史 / save 全复用（engine 仅记录维度）
        ▼
audio_runner.py（主 ASR venv）
  ├─ 校验 engine 运行时就绪 + Qwen3-ASR 0.6B 可回读
  ├─ cosyvoice2 ──► tts_runner.py（-cosyvoice venv，现状不动）
  └─ indextts25 ──► indextts_runner.py（-indextts venv，torch2.8/transformers4.52）
        │ 合成 WAV → 单次 Qwen3-ASR 回读（fidelity ≥ 0.85）→ meta.json
        ▼
~/.recut/models/audio-studio/
  ├─ cosyvoice/   （现状）
  └─ indextts/
      ├─ IndexTTS-2.5/         主权重 5.1GiB（含 config.yaml）
      └─ default_voice.wav     默认音（模型仓库示例人声）
```

数据流：**引擎选择 → 统一 synthesize op → 按引擎分派 worker → 统一回读验收 → 统一历史/预览/保存**。引擎差异只发生在「参数面板渲染」与「worker 执行」两处。

## 7. 引擎与运行环境

### 7.1 Bootstrap（`bootstrap.py`）

> **懒加载原则（D11）**：IndexTTS 的源码、venv 与权重**只在该用户实际点击「下载 IndexTTS-2.5」时按需安装**。默认 `prepare` 仍只维护 ASR 与 CosyVoice 两个既有环境，把不使用的用户的安装足迹（venv pip 包 + 5.1GiB 权重）保持在现状。这与「不能与应用共用 venv」共同构成降门槛的完整答案：venv 合并不可行（三套 torch/transformers/numpy 硬 pin 互斥），但按需触发可以把成本限制在真正选择 IndexTTS 的用户身上。

- `bootstrap.py` 新增 `INDEXTTS_REVISION`（固定上游 commit）与 `ensure_indextts_runtime()`（幂等）：以 `install_archive()` 下载 index-tts 源码到 `~/.recut/models/audio-studio/indextts/repository`，创建第三个 venv `-indextts`，安装 `python/indextts.requirements.lock` 完整闭包并 `pip check` + `indextts_runner.py status` 自检。
- `ensure_indextts_runtime()` **不在默认 `main()` 中执行**，由 `audio.install { model:"indextts25" }` 的 worker 前置调用；`audio.status` 未安装前 `engines.indextts25.repository/runtime/ready` 均为 `false`，UI 只显示下载按钮。
- `indextts.requirements.lock` 固定：`torch==2.8.*` / `torchaudio==2.8.*`（Linux 走官方 cu128 索引，macOS 走 PyPI 含 MPS 的构建）、`transformers==4.52.1`、`numpy==2.2.6`、`librosa==0.10.2.post1`、`tokenizers==0.21.0`、`sentencepiece>=0.2.1`、`modelscope`（下载用）、`safetensors==0.5.2`、`omegaconf`、`munch`、`einops`、`cn2an`、`jieba`、`fugashi`/`unidic-lite`（日文）、`g2p-en`、`wetext`/`WeTextProcessing`（按平台）、`onnxruntime`、`soundfile`、`tqdm`。**不装** `gradio`/`deepspeed`/`flash-attn`/`triton`/`tensorboard`/`matplotlib`/`opencv-python`/`pandas`/`keras` 等 WebUI/训练侧依赖（骨架代码只在 WebUI 路径 import，推理路径不触碰）。

### 7.2 Install 目标（`audio.install`）

- `model` 枚举新增 **`indextts25`**：下载 `IndexTeam/IndexTTS-2.5` 到 `~/.recut/models/audio-studio/indextts/IndexTTS-2.5/`（沿用 `download_repo`，`source` 支持 automatic/huggingface/modelscope）。
- 下载 `config.yaml`（`ensure_config_available` 等价：从模型仓库只取该文件）。
- 复制 `examples/voice_01.wav` 为 `default_voice.wav`（D9）。
- 首帧辅助权重（`w2v-bert-2.0`、`campplus_cn_common.bin`）由 worker 首次加载自动补齐到 `model_dir/hf_cache`，安装阶段不预下载（避免把 5.1GiB 之外再叠加不确定体积）。
- 安装完成打印体积与磁盘提示（约 5.1GiB，明显大于 CosyVoice 的 2.7GiB）。

### 7.3 Worker（`python/indextts_runner.py`，新增）

镜像 `tts_runner.py` 契约：持续输出阶段日志，末行单行 JSON `{ready, duration, sampleRate, ...}`。

```text
status
  - 校验 python 3.10~3.12、torch 2.8、transformers 4.52.1、numpy 2.2.6
  - find_spec("indextts.infer_v2_5") 与模型目录关键文件存在

synthesize --model-dir --cfg-path --text --lang --reference
           [--emo-reference] [--params-json] --output
  - 按设备自动 use_bf16（CUDA 支持 bf16 → True，否则 False）
  - 若 params_json.mode == "text" → use_qwen_emo=True 加载（否则 False）
  - 组装 infer_kwargs：
      spk_audio_prompt=reference, text, lang, output_path,
      emo_audio_prompt=(mode=="audio" ? emo-reference : None),
      emo_vector=(mode=="vector" ? normalize_emo_vec(vec, apply_bias=True) : None),
      use_emo_text=(mode=="text"), emo_text=(mode=="text" ? emoText or None : None),
      use_random, emo_alpha, duration_factor,
      max_text_tokens_per_segment, top_p, top_k(30), temperature,
      length_penalty(0.0), num_beams(3), repetition_penalty, max_mel_tokens,
      verbose=False
  - 逐 chunk 收集 tts_speech，波形质量检查（finite + peak），
    sf.write → 22050 Hz 单声道 PCM_16 WAV
  - 多语言输出时长比 CosyVoice 更易超长：分片循环 + 心跳沿用现约定
```

### 7.4 `audio_runner.py` 分派

- `run_tts_worker(engine, args)`：`cosyvoice2` → `-cosyvoice` venv python + `tts_runner.py`；`indextts25` → `-indextts` venv python + `indextts_runner.py`。共用 `parse_worker_result` 与心跳中继。
- `state()` 的 `tts` 改为 `engines`（§8.3）。
- `synthesize()` 按 engine 分支：CosyVoice 路径保持现状（角色 prompt-text / 默认音）；IndexTTS 路径用 `character.sample_path` 或 `default_voice.wav` 作 `--reference`，把 `params_json` 透传。
- `prepare_character()` 增加 `--engine`（Phase 2，§9），默认仍 `cosyvoice2`。

## 8. 数据与接口契约

### 8.1 Manifest / 后台操作

**`audio.install`**（`inputSchema.model` 枚举）加 `"indextts25"`。

**`audio.synthesize`**（保持单一 op，`inputSchema` 扩展）：

```text
required: ["text"]
properties:
  text:        string
  engine:      enum ["cosyvoice2","indextts25"]            default "cosyvoice2"
  characterId: string                                      optional
  style:       enum ["neutral","calm","excited","gentle"]  optional（仅 cosyvoice2）
  lang:        enum ["ZH","EN","JA","AR","ES"]             optional（仅 indextts25，默认 ZH）
  durationFactor: number (0.5–2.0)                         optional（仅 indextts25，默认 1.0）
  emotion: {
    mode: enum ["same-as-speaker","audio","vector","text"] default "same-as-speaker"
    referenceAssetId: string   // mode=audio，素材库音频 assetId，后台 materialize
    vector: number[8]          // mode=vector，顺序 [喜,怒,哀,惧,厌恶,低落,惊喜,平静]
    emoText: string            // mode=text，可空（空则用 text 本身）
    alpha:  number (0–1)       // 默认 0.65（mode=text 建议 0.6）
    random: boolean            // 默认 false
  }
  advanced: { temperature?, topP?, repetitionPenalty?, maxMelTokens? }  optional（仅 indextts25）
  verify: boolean default true  // 保留默认开；不提供 UI 关闭入口
```

校验：`engine` 与参数强绑定（如 `indextts25` 不接受 `style`，`cosyvoice2` 不接受 `lang`/`emotion`）；`mode=vector` 时 `vector` 必须 8 个 0~1 数字；`mode=audio` 时 `referenceAssetId` 必填且须为 completed audio 素材。

**`audio.status`**：`tts` 结构调整，同时保留向后兼容字段：

```jsonc
"tts": {
  "ready": true,                 // 任一引擎就绪 && 回读器就绪（向后兼容）
  "verification": true,          // qwen3-asr-0.6b 已装
  "engines": {
    "cosyvoice2": { "repository": true, "model": true, "runtime": true,
                    "versions": {…}, "ready": true },
    "indextts25": { "repository": true, "model": true, "runtime": true,
                    "qwenEmo": false, "versions": {…}, "ready": true }
  }
}
```

`indextts25.ready = repository(源码) && model(权重+config) && runtime(venv 自检)`；`qwenEmo` 表示 QwenEmotion 目录是否存在（`mode=text` 前置提示，不必强制预装）。

**`audio.synthesis.complete` / `audio.syntheses`**：返回记录新增 `engine` 与 `params`（解析后的 params_json），供历史卡与预览展示引擎徽标与参数摘要。

### 8.2 SQLite

```sql
-- audio_syntheses 增加两列（ensureColumn 幂等迁移）
alter table audio_syntheses add column engine text not null default 'cosyvoice2';
alter table audio_syntheses add column params_json text not null default '{}';

-- audio_characters（Phase 2）记录验收引擎
alter table audio_characters add column engine text not null default 'cosyvoice2';
```

- `params_json` 存 `{ lang, durationFactor, emotion, advanced }`，作为历史展示与重生成依据。
- `engine` 是记录维度，不参与 `synthesize` 任务模型的 action（仍为 `"synthesize"`）。

### 8.3 UI 类型（`types.ts`）

```ts
export type TtsEngine = "cosyvoice2" | "indextts25";
export type IndexTtsLang = "ZH" | "EN" | "JA" | "AR" | "ES";
export type IndexTtsEmotionMode = "same-as-speaker" | "audio" | "vector" | "text";
export type IndexTtsEmotion = {
  mode: IndexTtsEmotionMode;
  referenceAssetId?: string;
  vector?: number[];          // length 8
  emoText?: string;
  alpha: number;              // 0.65 default
  random: boolean;
};
export type IndexTtsAdvanced = {
  temperature: number;        // 0.8
  topP: number;               // 0.8
  repetitionPenalty: number;  // 10.0
  maxMelTokens: number;       // 1500
};
export type Synthesis = {
  id: string; characterId: string; text: string; style: VoiceStyle;
  engine: TtsEngine; params?: IndexTtsParams;
  savedAssetId: string; createdAt: string; outputURL: string; duration: number;
};
```

### 8.4 草稿持久化（`sessionStorage`）

键升级为 `recut.audio-studio.synthesis-draft.v2`，读取时对 v1 做迁移（`engine:"cosyvoice2"`、style 原值）。新增字段：`engine`、`lang`、`durationFactor`、`emotion`、`advanced`。

## 9. UI 参数设计

### 9.1 布局（配音步骤）

```text
┌ 要朗读的内容 ─────────────────────────────┐
│ [textarea]                                │
│ · IndexTTS 提示：文本内可注音 <行|XING2>    │
├ 引擎 ─────────────────────────────────────┤
│ (●) CosyVoice2  (○) IndexTTS-2.5         │   ← 引擎选择器（单选卡片）
│   CosyVoice2：轻量 2.7GiB · 中英          │
│   IndexTTS-2.5：五语种 · 情感 · 语速 5.1GiB│
├ 声音（角色列表，与引擎共用）────────────────┤
│ (○) 默认音  (角色卡片… 选中高亮)           │
├ 引擎参数面板（随引擎切换）──────────────────┤
│ CosyVoice2 → 情绪指令 4 选（现状不变）      │
│ IndexTTS-2.5 →
│   语言   [ ZH | EN | JA | AR | ES ]
│   语速   [slider 0.50 ─1.00─ 2.00] 快← →慢
│   情感方式 [○同音色 ○参考音 ○向量 ○描述文本]
│     ├ 参考音 → 选择情感参考音频（素材库选择器）
│     ├ 向量   → 喜 怒 哀 惧 厌恶 低落 惊喜 平静（8×slider 0–1）
│     │         + 情感强度 slider 0–1 + 随机采样 checkbox
│     └ 描述   → 情感描述文本框 + 强度 slider 0–1 + 随机采样
│                 + 「实验性，需下载 QwenEmotion ~1.2GiB」提示
│   ⚙ 高级参数 [accordion 收起]
│     temperature · top_p · repetition_penalty · max_mel_tokens
│     + 恢复默认
├ 就绪区 ────────────────────────────────────┤
│ IndexTTS-2.5 未下载 → [下载权重 5.1GiB]    │
│ 或 ✓ IndexTTS-2.5 已就绪                  │
└───────────────────────────────────────────┘
```

### 9.2 能力 → UI 参数映射表

| IndexTTS 参数 | 控件 | 默认 | 说明 |
|---|---|---|---|
| `lang` | 下拉（ZH/EN/JA/AR/ES） | ZH | 提示「选择文本语言；也支持跨语种克隆」 |
| `duration_factor` | 滑块 0.5–2.0 step 0.05 | 1.0 | 两端标注 快/慢（<1 加速、>1 放慢） |
| 情感模式 0 同音色 | 单选 | 选中 | 无额外参数 |
| 情感模式 1 参考音 | 单选 + 素材选择器 | — | 复用 `recut.media.pick(["audio"])` |
| 情感模式 2 向量 | 单选 + 8 滑块 + 强度 + 随机 | 全 0 / 0.65 / 关 | 滑块 0–1 step 0.05；8 轴中文名标注 |
| 情感模式 3 描述文本 | 单选 + 文本框 + 强度 + 随机 | 0.6 / 关 | 实验徽标 + QwenEmotion 提示 |
| `emo_alpha` | 强度滑块 0–1 step 0.01 | 0.65 | 模式 1/2/3 可见 |
| `use_random` | 随机采样 checkbox | 关 | 模式 2/3 可见；注明会降低克隆保真度 |
| 高级采样 | accordion 内滑块 | 官方默认 | 仅 temperature/top_p/repetition_penalty/max_mel_tokens |
| 发音控制 | 文本框 hint 文案 | — | 无控件，文档化 `<行|XING2>` 语法 |

### 9.3 状态与交互规则

- **引擎切换**：切换清空 `selectedSynthesis` 预览高亮；角色列表与文本保留（跨引擎共享）；草稿随之更新。
- **就绪门控**：`synthesize` 主按钮需要 `text 非空 && 对应引擎 ready && 回读器 ready`。CosyVoice 未装不影响 IndexTTS 面板，反之亦然（每引擎独立下载按钮）。
- **历史卡**：合成卡片加引擎徽标（CosyVoice2 / IndexTTS-2.5）；IndexTTS 卡片副标题显示 `lang · 语速x · 情感摘要`（如 `ZH · 1.0x · 情感参考音`）。
- **草稿恢复**：v2 草稿按引擎字段完整恢复参数面板。

### 9.4 i18n 新增（`i18n.ts` zh/en 双语言）

引擎标签与 note、语言 5 项、语速标签与快/慢、情感四模式标签与说明、8 情感轴名、情感强度/随机采样、实验性提示与 QwenEmotion 下载提示、`indextts25` 下载按钮（5.1GiB）、发音注音提示、历史引擎徽标与参数摘要、高级参数各项与恢复默认、草稿迁移不涉及文案。

## 10. 分阶段实施

**Phase 0 —— 依赖与运行时（可独立验收）**
1. 固定 index-tts 上游 revision；`bootstrap.py` 增加 `ensure_indextts_runtime()`（**懒加载**：默认 `prepare` 不执行，仅由 `audio.install indextts25` 前置调用）+ `indextts.requirements.lock`；`pip check` + `indextts_runner.py status` 自检。
2. `python/indextts_runner.py` 实现 `status` / `synthesize`（含情感四模式、语速、采样参数、心跳日志）。
3. `audio_runner.py`：`install` 增加 `indextts25` 下载目标（先 `ensure_indextts_runtime()` 再下载权重，含 config.yaml 与 default_voice.wav）；`state()` 增加 `engines.indextts25`；`run_tts_worker` 引擎分派。
4. 手工脚本级验证：对固定文本用默认音直接跑通 IndexTTS 合成 + 回读验收，记录时长/显存/质量基线。

**Phase 1 —— 后端契约**
5. `manifest.json`：`audio.install` 枚举加 `indextts25`；`audio.synthesize` inputSchema 扩展 engine+params；`audio.status` 文档同步。
6. `background.js`：`synthesize()` 解析 engine 参数、`emotion.referenceAssetId` materialize、写 `params_json`；`audio_syntheses` 加列（ensureColumn）；`synthesis.complete/syntheses` 返回 engine+params。
7. `skills/audio-studio/SKILL.md` 与 `README.md` 更新双引擎说明与验收不变纪律。

**Phase 2 —— 角色管线解耦（解锁 IndexTTS 独立可用）**
8. `prepare_character` 增加 `--engine`（cosyvoice2 | indextts25 | auto）：IndexTTS 路径以「参考音可加载 + ≤15s」替代 CosyVoice 声纹验证，校准合成用所选引擎（IndexTTS 校准语言由 ASR 检测映射，默认 ZH）。
9. `audio_characters` 加 `engine` 列；`characterQuality` 改为引擎感知（CosyVoice 验声纹，IndexTTS 验参考音）；`characters`/`character.complete` 相应调整。
10. 角色创建面板增加引擎选择；历史角色卡显示验收引擎徽标。

**Phase 3 —— UI 落地**
11. `types.ts` 加 TtsEngine/IndexTtsParams 等类型；`i18n.ts` 全量新增文案（§9.4）。
12. `main.tsx`：引擎选择器 + 参数面板条件渲染（语言/语速/情感四模式/高级）+ 独立下载按钮 + 历史引擎徽标 + 草稿 v2（含 v1 迁移）。
13. 验证模式 1/2/3 的全链路（含 QwenEmotion 按需加载与实验提示）、语速、高级参数、历史/保存/预览。

**Phase 4 —— 一致化与回归**
14. 新老项目兼容回归：CosyVoice 引擎行为、旧草稿迁移、旧历史卡展示。
15. `README.md`、`SKILL.md`、`manifest.json` 反向更新；`rfc/README.md` 同步；端到端验证（§11）。

## 11. 测试与验证

沿用音频工坊既有分层设施，不引入新框架：

- **L1 后台/worker（脚本级 hermetic）**：
  - `indextts_runner.py status` 在完整/缺模型/缺依赖三种环境下返回正确 ready 与 error。
  - `synthesize` 四种情感模式与语速/高级参数按 fixture 文本出 WAV；`mode=vector` 校验 `normalize_emo_vec` 输出维度与范围；`mode=text` 且未装 QwenEmotion 时给出明确前置错误。
  - `audio_runner.install indextts25` 幂等、config.yaml/default_voice 落盘；断网回退 ModelScope。
  - `background.synthesize`：engine 参数强校验、`referenceAssetId` materialize、params_json 落库、历史返回 engine。
- **L2 UI（Playwright / 手动验收）**：引擎选择器切换正确显隐面板；8 滑块/强度/随机状态正确组装进 op；下载按钮独立就绪；历史卡引擎徽标与参数摘要；草稿 v1→v2 迁移。
- **L3 端到端（真实 service + app）**：固定脚本文本（中/日/西各一段）经 IndexTTS 合成 → Qwen3-ASR 回读保真度达标 → 预览可播 → 显式入库产生 Asset；与 CosyVoice 同文本并行跑回归。

**命令**：L1 直接 `python/audio_runner.py ...` 与两个 venv 的 runner；L3 需 `make dev` 全链路。

## 12. 风险与取舍 / 开放问题

- **风险 1（GPU 依赖，MPS 尤其受限）**：IndexTTS 官方 RTF 数据基于 RTX 4090（2.5 整体 ~0.20）。推理路径虽支持 MPS，但实测是**社区级、非官方支持**：无 macOS CI、无 MPS 内存管理；MPS 上**强制 fp32**（`use_bf16` 被写死为 False），实测 RTF 约 **1.7 ~ 8.0**（M4 一段 20.5s 音频耗时 165s；官方口径 normal RTF≈5），远慢于 4090 的 0.2；并存在两类已知故障：① macOS < 15.1 / 老 M1 上 BigVGAN `conv_transpose1d` 报 `Output channels > 65536 not supported at the MPS device`（需 macOS 15.1+ / torch≥2.6，或 `PYTORCH_ENABLE_MPS_FALLBACK=1` 走 CPU 回退更慢）；② 单次合成内存占用 20~80+GiB（`torch.cuda.empty_cache()` 在 MPS 是 no-op，缓存永不释放），可冻结整机。产品对策：`audio.status` 上报 `torch.cuda.is_available()` 与设备名，IndexTTS 面板在非 CUDA 设备上展示「社区支持、性能受限」提示与预计耗时；保留 CosyVoice 作为默认引擎不受影响。
- **风险 2（多语言回读阈值）**：Qwen3-ASR 0.6B 对日/西/阿的识别质量与 `normalized_text` 相似度在 0.85 阈值下可能偏严。方案：Phase 1 沿用 0.85 并记录各语言实际保真度基线；Phase 4 按语言微调阈值（如 0.80）并保持验收纪律不变。
- **风险 3（许可证）**：IndexTTS 采用 bilibili Model Use License，商用需联系官方。需要：下载前展示许可证确认；`install indextts25` 的日志/文档标注许可证来源。
- **风险 4（磁盘与加载）**：5.1GiB 权重 + 每次合成完整加载模型（与 CosyVoice 同模式），合成首帧耗时显著。需要：下载前体积提示、加载心跳（已有约定）；不做常驻服务。
- **开放问题 1（默认音选择）**：用模型仓库 `examples/voice_01.wav` 作为默认音与模型同许可证，但发音内容未针对产品调优。备选：内置一段自录干净人声（需额外清理许可与源文件）。倾向先复用官方示例，后续可替换。
- **开放问题 2（角色管线引擎）**：Phase 2 的角色「引擎可选」让 IndexTTS 独立可用，但同一角色由不同引擎验收的标准不完全一致（CosyVoice 验声纹 vs IndexTTS 验参考音+校准）。接受差异，角色记录注明验收引擎（D8）。
- **取舍**：比「第三套 venv + 新 worker」多一份依赖维护成本，换来与 Qwen3-ASR、CosyVoice 的版本冲突彻底隔离，并可独立升级任一引擎；融合进配音步骤以参数面板单点复杂度换取全部产品流复用。

## 13. 验证验收清单（采纳后）

1. 配音步骤出现引擎选择器；未选 IndexTTS 时 CosyVoice 行为与 UI 完全不变。
2. `audio.install { model:"indextts25" }` 成功下载 5.1GiB 权重 + config.yaml + default_voice.wav；`audio.status` 的 `engines.indextts25.ready` 为 true。
3. 默认音 + 中文文本可合成并回读验收通过；切换 `lang=JA/ES` 可跨语种出音；`duration_factor=0.8/1.2` 可闻变快/变慢。
4. 情感模式 1（参考音）/ 2（8 向量+强度）/ 3（描述文本，QwenEmotion 按需加载）各产出一条验收通过的 WAV；未装 QwenEmotion 时模式 3 给出前置提示。
5. 历史合成卡显示引擎徽标与参数摘要；旧记录（engine 默认 cosyvoice2）正常展示。
6. 草稿 v1 → v2 迁移不丢文本/角色；重启后 IndexTTS 参数面板完整恢复。
7. Phase 2 后：仅装 IndexTTS（不装 CosyVoice）也能创建角色并合成。
8. 任一引擎输出必须过 ASR 回读 ≥0.85（或按语言调整后的阈值）才可预览/保存；失败结果不进历史。
9. `make` 既有检查与 L1/L3 用例全绿。

## 14. 不采纳边界（明确不做）

- 不做 **IndexTTS-2 / 1.5**：只接 2.5（五语种、语速、发音控制、情感四模式、更快推理）。
- 不做 **vLLM / 云端部署**：保持本地自托管，不走 `recipes.vllm.ai/IndexTeam/IndexTTS-2.5`。
- 不做 **DeepSpeed / flash-attn / torch.compile 加速**：降低环境构建风险，留待后续按需评估。
- 不做 **训练 / 微调 / 术语词汇表管理**：index-tts 的 glossary 管理属于模型定制，超出配音工作台范围。
- 不做 **合成预览即自动入库**：输出仍先留私有区，用户确认后才进素材库（平台纪律）。
- 不做 **情感参数自动推荐**：四模式由用户显式选择，`mode=text` 保持实验性标注。