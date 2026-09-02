<!--
 * [INPUT]: 依赖 audio-studio 现状（background.js 的 audio.character.create / audio.synthesize 契约与任务模型、
 *          audio_runner.py 的 CosyVoice 合成 + Qwen3-ASR 回读验收、voxcpm_runner.py 的 Voice Design 固定描述 VOXCPM_DESIGN_DESC、
 *          ui 的角色/配音三步工作流、manifest 的 operation 契约、Creation Worlds 的 voice_reference 证据角色）
 *          以及市场事实（剪映/逗哥/魔音等短视频配音平台的流行音色分布：解说小帅 ~38%、情感女 ~22%、悬疑男 ~15%、童声 ~12%、带货/方言/喜剧为长尾；
 *          阿里百炼 CosyVoice 预置音色为云端 API 专用；AISHELL-3、Emilia、Common Voice 为 Apache-2.0/CC-0 可商用语音数据集）
 * [OUTPUT]: 定义声音工坊「默认声音角色库（20 个风格预设）」与「VoxCPM2 Voice Design 声音设计」能力：
 *          预设 = CDN 托管的参考音资产（官方发布管线生成）+ 代码内元数据清单，用户端按需 resolve 下载缓存、零推理；
 *          新增 audio.presets / audio.character.design op（MCP 可用），AI 在创建 World 角色时可调用设计声音并落为 voice_reference 证据；
 *          UI 在角色步骤提供「设计声音」模式与预设一键实例化
 * [POS]: rfc 的 audio-studio 声音预设库 + Voice Design 声音设计实施蓝图；获批后落到 manifest/background.js、audio_runner.py、voxcpm_runner.py、
 *        ui/src/main.tsx + i18n.ts + types.ts、skills/audio-studio/SKILL.md，并反向更新 README
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 -->

# RFC: 声音预设库（20 个默认角色）与 VoxCPM2 Voice Design 声音设计能力

- 状态：**草案（待评审）**
- 作者：Recut
- 日期：2026-09-02
- 决策范围：默认声音角色库的内容与来源、预设的引擎无关实现、`audio.character.design` 新 op（UI + MCP 双面）、与 Creation Worlds `voice_reference` 证据的打通、数据契约、验收与分阶段实施
- 关联：`manifest.json`、`background.js`、`python/audio_runner.py`、`python/voxcpm_runner.py`、`ui/src/main.tsx`、`ui/src/i18n.ts`、`ui/src/types.ts`、`skills/audio-studio/SKILL.md`、`README.md`、平台 `recut.worlds.*`（只消费，不改动）、上游 `OpenBMB/VoxCPM`（Apache-2.0）、`FunAudioLLM/CosyVoice2`（仓库自带提示音）

## 1. 背景与病灶

声音工坊目前的「声音」只有两类：

1. **用户克隆角色**：`audio.character.create` 从参考音创建，需要用户自备 5~15 秒干净人声。
2. **两个伪默认音**：CosyVoice 官方 `zero_shot_prompt.wav`（固定一句「希望你以后能够做的比我还好呦」）与 VoxCPM2 的固定 Voice Design 描述「一位年轻、温和的中文女声，语气自然亲切」（`voxcpm_runner.py:19` 硬编码，仅 voxcpm2 可用）。

对照市场（2026 短视频配音平台数据抽样）：抖音 AI 配音中「解说小帅」类磁性男声占 ~38%、情感治愈女声 ~22%、悬疑男声 ~15%、童声 ~12%，其余为带货女声、方言（东北/粤语/川渝）、喜剧脱口秀等长尾。**用户新建 App 后面对的是一个近乎空白的声音列表**，必须自备参考音才能开始创作——这与「打开剪映就有 30+ 音色」的市场心智差距显著。同时，Agent 在为 World 角色挑声音时也没有任何可枚举、可复现的默认声线可用。

VoxCPM2 的 **Voice Design**（`text = (自然语言音色描述)正文` 前缀）恰好能把「声线」变成**文本可描述、可枚举、可复现**的资产：一行描述就是一个声音，零版权风险（自生成）、零额外下载（voxcpm2 权重内）、Agent 可编程调用。

**目标**：

1. 内置约 **20 个中文风格预设声音**（覆盖上表市场主流），开箱即用、引擎无关、可枚举。
2. 把「VoxCPM2 声音设计」升级为**一等能力**：UI 可用、MCP 可用——AI 在创建 World 角色时可直接设计一个声音角色并把参考音落为 `voice_reference` 证据。

**边界（本阶段不做）**：不克隆任何真人/网红声音（声音权益风险，民法典第 1023 条）；不引入云端音色 API（百炼预置音色是云端服务，与本地自托管路线冲突）；不改变角色数据模型的核心语义（角色 = 参考音 + 提示词）；不做多语言预设（20 个全部中文优先，英文留给用户克隆/设计）。

## 2. 核心决策

### D1：预设 = CDN 托管的 catalog（清单+元数据）+ 参考音资产，按需 resolve

每个预设条目 = `{ id, name, scene, blurb, designDesc, promptText, version, url, sha256, bytes, license, source }`（`name/blurb` 带 zh/en 双语字段）。**catalog 本身就是 CDN 上的版本 manifest**——它是预设清单的权威源，增删预设、改名、改听感文案、换音色都只动 CDN，不发 App 版本。App 内置一份**极简 bootstrap 清单**仅作离线兜底（预设 id + 名称，无音频）。

- 理由：
  - catalog 上 CDN 后迭代零 App 发版：加第 21 个预设、下架不达标的方言预设、微调文案，都是改一次 manifest。
  - wav 与 promptText 同 manifest 分发，**用户端 resolve 时零推理、零 ASR 依赖、不要求装任何 TTS 权重**。
  - 法律面：全部声源为 Apache-2.0 引擎自生成或 Apache-2.0/CC-0 语料，manifest 逐条记 `license` 字段。
- 代价：预设功能整体依赖首次联网拉 manifest；离线场景回退 bootstrap 清单 + 已缓存条目（未缓存条目显示「离线不可用」）。

### D2：按需 resolve——预设的引擎无关实现

参考音 wav 是引擎无关资产（cosyvoice2 零样本 / voxcpm2 隔离式 / voxcpm1.5·0.5b 延续式都只吃 wav+prompt_text）。方案：

```text
用户/Agent 选中预设（或 audio.synthesize 传 presetId）
  → 后台查找本地缓存 presets/<version>/<presetId>.wav
  → 命中：直接以 wav + promptText 作为参考音走既有合成路径（等价于一个只读角色）
  → 未命中：从 manifest.url 下载 wav → sha256 校验 → 落缓存 → 同路径使用
        （下载失败/离线 → 明确报错并提示联网；不回退到本地推理）
```

预设固化产物与用户克隆角色走完全相同的参考音语义，**所有引擎都能使用所有预设**，且不占用 voxcpm2 权重依赖。这顺路解决 VoxCPM RFC 的开放问题 1（默认音备选方案）：默认音成为 preset #1。

**发布管线（官方侧，一次性/迭代时）**：voxcpm2 按 designDesc 生成探针 → 实听定稿 → 离线 ASR 回读得 promptText（同时充当质量验收）→ 上传 CDN `<cdnBase>/<version>/<presetId>.wav` 并更新版本 manifest（含 sha256、license、变更记录）。

### D3：新增 `audio.character.design`——Voice Design 建角色成为一等 op

现有 `audio.character.create` 只接受 assetId（用户参考音）。新增：

```text
audio.character.design（surfaces: api + mcp）
  input:  { name: string, designDesc: string, presetId?: string, model?: 回读 ASR 模型, saveToLibrary?: boolean }
  行为:   { presetId }：resolve 预设参考音（缓存→CDN 下载）→ 以该 wav 建用户私有角色记录
          （origin="design"，参考音复制入角色私有区）——**不需要 voxcpm2**。
          { designDesc }：VoxCPM2 按描述生成探针 → Qwen3-ASR 回读验收 → 建角色（需要 voxcpm2）。
  返回:   异步 job；audio.character.complete 读取（沿用既有 pair 约定）。
  校验:   designDesc 与 presetId 二选一（presetId 时可另传 designDesc 覆写描述，但
          覆写即走本地生成分支）；designDesc 仅中文、≤ 120 字、不得包含真实人名
          （简单黑名单 + 文案引导）。
```

这把「只有 voxcpm2 合成时才能隐式用 Voice Design」提升为「任何时刻都能用一段描述创建角色」，角色一旦建成即引擎无关。

### D4：预设通过 MCP 可枚举，打通 World 角色链路

- 新增 `audio.presets`（surfaces: api + mcp）：返回 20 个预设清单（id、名称、场景标签、一句话听感描述、本地缓存状态）。只读、无副作用。
- World 角色的标准链路（写进 audio-studio SKILL.md 的「World 声音参考」一节）：

```text
AI 创建 World 角色（recut.worlds.entities.upsert character）
  → 需要 voice_reference 证据时：
     1. audio.presets 枚举 → 按角色人设挑 presetId（或按人设写 designDesc）
     2. audio.character.design { name: 角色名, presetId|designDesc, saveToLibrary: true }
        → recut.job.wait 终态 → 角色参考音自动入库为 audio asset
     3. recut.worlds.evidence.attach（或 entities.upsert 内联证据）
        { role: "voice_reference", assetId: <上一步返回的 assetId> }
```

平台侧**零改动**：`voice_reference` 证据角色已存在（`service/worlds.go:73`），audio-studio 只负责产出合格的音频 asset。跨 App 纪律不破坏——AI 仍只调 audio-studio 的公开 op 与平台 worlds op。

### D5：UI 双入口——预设选择器 + 设计模式

角色步骤（「声音角色」）与配音步骤的声音选择器各加一层：

```text
┌ 选择声音 ────────────────────────────────┐
│ [预设] 页签（默认展开）                    │
│   场景 tab：全部 / 解说 / 情感 / 悬疑 / 童趣 │
│            / 电商 / 方言 / 播报            │
│   预设卡：名称 + 听感一句话 + 试听 ▶        │
│          （未缓存的卡片首次点选触发 resolve 下载）│
│ [设计声音] 按钮 → 弹框：                   │
│   名称 + 音色描述 textarea + 从预设起步 ▾  │
│   → audio.character.design               │
│ [克隆] 既有参考音上传入口（现状不动）        │
└──────────────────────────────────────────┘
```

- 配音步骤的「默认音」两个伪选项收敛为预设卡（CosyVoice 官方默认音 = 预设 `neutral-female`；向后兼容：`characterId===""` 仍走旧默认音路径，仅 UI 不再直出）。
- 试听：未缓存的预设点 ▶ 触发 resolve（CDN 下载，复用任务中心与 job 观察设施，秒级）后播放；已缓存直接播缓存 wav。缓存条目右上角提供「清除」入口（省空间）。

### D6：数据与存储

```sql
-- audio_characters 加来源列（ensureColumn 幂等迁移）
alter table audio_characters add column origin text not null default 'clone';
-- 值域: clone(参考音上传) | design(Voice Design) | preset(由预设另存为用户角色)
```

预设元数据的权威源是 CDN manifest；App 内置 bootstrap 清单（`presets.ts`：id + 双语名称，离线兜底）。参考音缓存走 App 私有文件区，按版本分目录（迭代升版本后旧版本缓存可整体清除）：

```text
~/.recut/apps/recut.audio-studio/files/presets/<version>/<presetId>.wav
~/.recut/apps/recut.audio-studio/files/presets/cache.json
    ← { manifestVersion, presets: { presetId: { sha256, bytes, fetchedAt } }, fetchedAt }
      （仅缓存账本，可随时删除重建）

CDN（权威 catalog，随发布迭代）：

<cdnBase>/manifest.json          ← 最新版指针 { version, updatedAt, changelog? }
<cdnBase>/<version>/manifest.json
    ← { version, presets: [{ id, name:{zh,en}, scene, blurb:{zh,en},
                              designDesc, promptText, url, sha256, bytes, license, source }] }
<cdnBase>/<version>/<presetId>.wav
```

- `<cdnBase>` 首选 `https://cdn.recut.video/audio-studio/voices`（与 App 同生态；若暂不可用，退路是 GitHub Pages / Release assets）。
- 打开预设页签时拉 `manifest.json` 指针 → 命中新版本则拉取该版本 manifest 并热替换列表（含增删预设与文案更新）；弱网/失败静默回退 bootstrap 清单 + 已缓存文件。
- `scene` 为受控枚举（与 UI 场景 tab 对齐：`general/narration/emotion/suspense/kids/commerce/dialect/podcast`），manifest 里新增枚举值时旧 App 将其归入 `general` 显示。

## 3. 20 个默认声音（首批清单）

全部为 VoxCPM2 Voice Design 描述，中文优先。命名走风格化（不蹭真人）。`probeText` 统一用一段含数字、语气词、长短句的中文口播文案（验收友好）。

| # | presetId | 名称 | 场景 | 听感一句话 | designDesc（Voice Design 描述，直接进入 `(描述)文本` 前缀） |
|---|---|---|---|---|---|
| 1 | `neutral-female` | 小雅 · 中性女声 | 通用/播报 | 自然亲切的年轻女声，即现有 VoxCPM2 默认音 | 一位年轻、温和的中文女声，语气自然亲切（现状默认，保留复现性） |
| 2 | `jieshuo-xiaoshuai` | 解说 · 小帅风 | 影视解说 | 磁性男声，语速中快，悬疑开场腔 | 一位成熟磁性的中文男声，吐字清晰，语速稍快，带着一点点悬念感，像电影解说旁白 |
| 3 | `qinggan-nv` | 情感 · 暖阳 | 情感语录 | 温柔治愈、慢节奏、气声多 | 一位温柔的中文女声，语速缓慢，气息轻柔，像深夜电台的治愈系主播 |
| 4 | `xuanyi-nan` | 悬疑 · 低语 | 悬疑故事 | 低沉压迫感，句尾下沉 | 一位低沉的中文男声，语气冷静克制，带压迫感，适合讲述悬疑案件 |
| 5 | `tongsheng-nv` | 童声 · 糖糖 | 亲子/儿童 | 天真烂漫，叠词自然 | 一个天真活泼的中文小女孩声音，语气稚嫩可爱，像在读儿童故事 |
| 6 | `daihuo-nv` | 带货 · 小燃 | 电商 | 活泼高亢，促单节奏 | 一位充满活力的中文女声，热情明快，语速偏快，像直播间带货主播 |
| 7 | `bobao-nan` | 播报 · 正声 | 新闻/知识 | 端正干练、字正腔圆 | 一位沉稳干练的中文男声，字正腔圆，像新闻播音员 |
| 8 | `zhixing-nv` | 知性 · 静姝 | 知识科普 | 知性温和、从容不迫 | 一位知性从容的中文女声，语速平稳，清晰温和，像科普纪录片旁白 |
| 9 | `dongbei` | 东北 · 老铁 | 搞笑/生活 | 东北口音，豪爽幽默 | 一位说东北口音普通话的中年男声，豪爽幽默，像和熟人唠嗑 |
| 10 | `yueyu-nan` | 粤语 · 阿乐 | 粤语内容 | 地道粤语男声 | 一位地道的粤语男声，自然流利，像香港电视剧配音 |
| 11 | `sichuan-nv` | 川渝 · 幺妹 | 方言趣味 | 亲切四川话女声 | 一位亲切的四川话女声，语气泼辣爽朗，像成都街头主播 |
| 12 | `tuokouxiu-nan` | 喜剧 · 贫嘴 | 段子/脱口秀 | 诙谐、节奏感强、爱抖包袱 | 一位诙谐的中文男声，节奏感强，语气夸张生动，像脱口秀演员 |
| 13 | `dashu-wennuan` | 大叔 · 沉稳 | 有声书 | 浑厚温暖的长者声线 | 一位四十多岁的中文男声，声音浑厚温暖，像在炉边讲故事的旁白者 |
| 14 | `boke-nan` | 播客 · 闲谈 | 播客/对谈 | 松弛对话感、像和朋友聊天 | 一位放松自然的中文男声，像和朋友聊天，语气随和有呼吸感 |
| 15 | `shaonv-yuanqi` | 元气 · 跳跳 | 生活 vlog | 元气满满、语速轻快 | 一位元气满满的中文年轻女声，语速轻快，笑声感明显，像生活 vlog 博主 |
| 16 | `jiaocheng-nv` | 教程 · 清晰姐 | 教程/测评 | 清晰利落、干脆利落 | 一位清晰利落的中文女声，咬字干脆，语速适中，像产品测评博主 |
| 17 | `lishi-nan` | 历史 · 说书人 | 历史/文化 | 苍劲说书腔 | 一位苍劲有力的中文男声，像评书演员，抑扬顿挫，娓娓道来 |
| 18 | `guanggao-nan` | 广告 · 磁性嗓 | 品牌广告 | 深沉磁性、高级感 | 一位深沉磁性的中文男声，语速偏慢，字字有力，像高端品牌广告旁白 |
| 19 | `xiaodidi` | 少年 · 阳阳 | 校园/青少年 | 阳光少年音 | 一位十五六岁的中文少年声音，阳光开朗，朝气蓬勃 |
| 20 | `yeyin-tanci` | 御姐 · 冷艳 | 剧情/反差 | 冷艳御姐、慵懒中带锋利 | 一位冷艳的中文女声，语气慵懒中带着锋利，像都市剧中的御姐角色 |

> 描述文本是初稿，实施时按 Voice Design 实际试听逐条微调（这是本 RFC 唯一需要「手艺」的部分：每条都要实际生成、试听、回读验收通过才定稿）。方言条目（9/10/11）依赖 VoxCPM2 的口音能力，验收标准放宽为「听感可辨」，回读阈值单独记录不阻断。

### 与免费市场资源的关系

| 来源 | 可用性 | 本 RFC 用法 |
|---|---|---|
| VoxCPM2 Voice Design（Apache-2.0） | 本地自生成，零风险 | **20 个预设的全部声源** |
| CosyVoice2 仓库自带 `zero_shot_prompt.wav` | 官方随仓库分发 | 保留为向后兼容默认音路径 |
| 阿里百炼预置音色（longwan 等） | 云端 API 专用，非本地文件 | **不采用**（与本地自托管路线冲突，仅作风格命名参考） |
| AISHELL-3 / Emilia / Common Voice | Apache-2.0 / CC-0 可商用语料 | 备选：若某预设 Voice Design 效果不达标，可从语料库挑一条干净样本作该预设固化参考音（记入 manifest.json 来源字段） |

## 4. 架构总览

```text
UI 角色步骤 / 配音步骤声音选择器          MCP（Agent / World 流程）
  ├─ 预设页签（CDN catalog，bootstrap 兜底）  ├─ audio.presets → 枚举（含缓存状态）
  ├─ 设计声音弹框                          ├─ audio.character.design
  │    { name, designDesc|presetId }      │    { name, designDesc|presetId,
  └─ 克隆（现状不动）                      │      saveToLibrary: true }
        │ recut.background                ▼
        ▼                       background.js
background.js                      ├─ 新 op: presets / character.design
  ├─ design 任务（action:"design"） ├─ 复用任务中心 + source 标记（task-center-ux RFC）
        ▼                                 ▼
audio_runner.py
  ├─ resolve_preset(): 缓存查 → CDN 下载（sha256 校验）→ 本地 wav + promptText
  ├─ design_character(): presetId → resolve_preset 复用（零推理）；
  │    designDesc → voxcpm2 voice-design 生成探针 → ASR 回读验收 → 角色记录
  └─ synthesize(): presetId 解析为参考音（等效 characterId 路径，现状复用）
        ▼
voxcpm_runner.py：--design-desc / --seed 参数化（替换 VOXCPM_DESIGN_DESC 硬编码）
（官方发布管线：voxcpm2 批量生成 20 条探针 → 实听定稿 → 离线 ASR → 上传 CDN manifest）
```

## 5. 决策记录

| # | 决策 |
|---|---|
| D1 | 预设 = CDN 托管的参考音 wav + 代码内元数据清单；不随 App 分发音频，不本地推理生成；按需 resolve。 |
| D2 | resolve：缓存 → CDN 下载（sha256 校验）→ 本地缓存，wav+promptText（发布时离线 ASR 生成）对全部引擎可用；**用户端零推理**。 |
| D3 | 新增 `audio.character.design` op（api+mcp）：presetId 分支零推理（复用 resolve），designDesc 分支走 voxcpm2 本地生成；产物为 origin="design" 的普通角色。 |
| D4 | 新增 `audio.presets` 只读枚举 op（api+mcp）；World 角色的 voice_reference 打通链路写入 SKILL.md，平台 worlds 侧零改动。 |
| D5 | UI 双入口：声音选择器加「预设」页签 + 「设计声音」弹框；克隆入口现状不动；缓存条目可清除。 |
| D6 | `audio_characters` 加 `origin` 列；预设缓存走文件区按版本分目录 + cache.json 账本，不入 SQLite。 |
| D7 | 20 个预设全部中文优先，命名风格化、不蹭真人；designDesc 逐条实听定稿后走官方发布管线（生成→实听→离线 ASR→上传 CDN manifest）。 |
| D8 | `audio.synthesize` 增加**可选** `presetId`（与 characterId 互斥），解析为参考音后走既有合成路径，回读验收纪律不变。 |
| D9 | **catalog 权威源在 CDN**：`<cdnBase>/manifest.json`（版本指针）+ `<version>/manifest.json`（含双语 name/blurb、designDesc、promptText、url、sha256、license）；App 内置 bootstrap 清单仅离线兜底；弱网静默降级。CDN base 首选 `cdn.recut.video/audio-studio/voices`，退路 GitHub Pages/Release。 |

## 6. 数据与接口契约

### 6.1 Manifest 新增 / 修改

```text
audio.presets（新增，api+mcp）
  input: {}
  output: { presets: [{ id, name, scene, blurb, designDesc, version,
                        source: "manifest" | "bootstrap",
                        cached: bool, cachedBytes?: number }] }
  # name/blurb 随宿主 locale 取 manifest 双语字段；source=bootstrap 表示当前离线兜底清单

audio.character.design（新增，api+mcp）
  required: ["name"]
  properties:
    name:         string
    designDesc:   string   # 与 presetId 二选一
    presetId:     string   # 传则取预设描述，可再传 designDesc 覆写微调
    model:        enum(回读 ASR 模型，缺省 qwen3-asr-0.6b)
    saveToLibrary: boolean # true 时终态参考音自动入库并返回 assetId（World 链路依赖）

audio.synthesize（修改）
  properties += presetId: string   # 与 characterId 互斥；解析为固化参考音
```

### 6.2 Worker（`voxcpm_runner.py`）

- `VOXCPM_DESIGN_DESC` 从模块常量改为 `--design-desc` 参数（缺省值保留现描述，向后兼容）；`--seed` 暴露（缺省 42，保证预设可复现）。
- 其余不变：`generate(text=(desc)+text, cfg_value=2.0, inference_timesteps=10)`。

### 6.3 `audio_runner.py` 新增 `resolve_preset()` 与 `design_character()`

- `resolve_preset(preset_id, version)`：
  - 缓存查 `presets/<version>/<presetId>.wav`（cache.json 记 sha256）→ 命中即返回 `{ wav, promptText }`。
  - 未命中：拉 CDN manifest（内置清单兜底）→ 取 `url/sha256/promptText` → 下载 → sha256 校验 → 落缓存 → 返回。下载失败报可读错误（含网络提示）。
- `design_character(name, design_desc|preset_id, ...)`：
  - `preset_id` 分支：`resolve_preset()` 复用 → 复制 wav 入角色私有区 → 写角色记录（origin="design"），**零推理**。
  - `design_desc` 分支：VoxCPM2 探针合成 → 波形质量检查 → ASR 回读（保真度 ≥ 0.85）→ 写角色记录（需要 voxcpm2 权重）。
  - 探针文本 `PROBE_TEXT`（统一，验收友好）：包含问候、数字、转折、语气词，约 40~60 字，如：「大家好，欢迎收听本期内容。今天我们聊聊第 3 个方法，其实它比你想的更简单——只要迈出第一步，剩下的就是坚持。」

## 7. UI 要点

- **声音选择器**（配音步骤 + 角色步骤共用组件化）：页签 `预设 / 我的角色`。预设页签按场景 tab 分组；卡片 = 名称 + 听感一句话 + 试听 + 缓存状态徽标；未缓存卡片试听即触发 resolve 下载（秒级，日志可见，任务中心留痕），已缓存提供「清除」入口。
- **设计声音弹框**：名称（必填）+ 音色描述 textarea（带示例占位文案与 120 字上限）+「从预设起步」下拉（选中即填充描述可改）+ 提交按钮 → 复用 `beginJob` 管线。
- **历史/任务**：design 与 clone/synthesize 共用任务中心（action: `design`），meta 记 `{ presetId?, designDesc 摘要 }`。
- **i18n**：20 个预设的名称/blurb、场景 tab、设计弹框全部文案（zh/en 双份）。
- **草稿**：选中 presetId 持久化到现有 draft 键结构。

## 8. SKILL.md 更新（Agent 消费面）

新增章节「为 World 角色设计声音参考」：

1. `audio.presets` 枚举，按角色人设选 scene/presetId；无合适预设则按人设自写中文 designDesc（给出写法模板：**年龄/性别 + 音色质地 + 语速节奏 + 参照场景**，不写真实人名）。
2. `audio.character.design { name, presetId|designDesc, saveToLibrary: true }` → `recut.job.wait` → 取 `assetId`。
3. `recut.worlds.entities.upsert`（character）时内联或 `recut.worlds.evidence.attach` 一条 `role:"voice_reference"` 证据。
4. 纪律：不克隆真人声音；designDesc 只描述声线特征；预设固化产物是共享缓存，用户角色（design 产物）才是可删除的私有资产。

## 9. 分阶段实施

**Phase 0 —— 定稿与发布管线（一次性，官方侧）**
1. 对 20 条 designDesc 逐条用 voxcpm2 生成、试听、微调定稿（记录最终文案、seed、voxcpm 版本）。
2. 离线 ASR 回读每条探针得 promptText（同时充当质量验收）；产出 `manifest.json`（含 sha256、license、source）与 20 个 wav，上传 CDN `<cdnBase>/<version>/`。产出物：本 RFC 附表更新 + CDN v1 manifest。

**Phase 1 —— 后端**
3. `voxcpm_runner.py`：`--design-desc` / `--seed` 参数化。
4. `audio_runner.py`：`resolve_preset()`（CDN 下载 + sha256 校验 + 版本化缓存）+ `design_character()` + `synthesize()` 的 presetId 解析。
5. `background.js` + `manifest.json`：`audio.presets` / `audio.character.design` 注册与 schema；`audio.synthesize` 加 presetId；`audio_characters` 加 origin 列（ensureColumn）；design/resolve 任务接入任务中心。

**Phase 2 —— UI**
6. `types.ts` / `i18n.ts` 全量类型与文案。
7. `main.tsx`：预设页签（分组、试听、缓存徽标、清除）+ 设计弹框 + 草稿兼容。

**Phase 3 —— 文档与打通**
8. `SKILL.md` 增加 World 声音参考链路章节；`README.md` / `README.en.md` 同步。
9. 端到端验证（§10）。

## 10. 测试与验证

- **L1 worker/runner（脚本级）**：
  - `resolve_preset()`：缓存命中不下载 → 未命中下载并 sha256 校验 → 断网时命中缓存可用、未命中报可读错误 → 校验失败的文件拒收并删除。
  - `design_character()`：presetId 分支零推理建角色；designDesc 分支生成 → 回读验收通过 → 建角色。
  - `synthesize(presetId)`：resolve 后 cosyvoice2 / voxcpm2 / voxcpm1.5 三引擎各产出验收通过 WAV；presetId 与 characterId 同传报错。
  - 旧路径回归：`--design-desc` 缺省时 voxcpm2 默认音行为与现状一致。
- **L2 UI（手动）**：预设页签分组与试听；未缓存预设触发 resolve 并可见下载进度/日志；缓存徽标与清除；设计弹框从预设起步；角色详情对 origin=design 角色正常展示/删除。
- **L3 端到端（真实 service）**：Agent 流程——`audio.presets` → `audio.character.design(saveToLibrary:true)` → `recut.job.wait` → world entity 挂 voice_reference 证据 → 在世界驱动的配音里使用该角色。

## 11. 风险与开放问题

- **风险 1（CDN 可用性与 catalog 热更新）**：预设功能依赖首次联网拉 manifest；catalog 热更新意味着远端内容不完全受 App 版本控制。对策：sha256 校验 + 失败可读报错；bootstrap 清单兜底（保证 `audio.presets` 永远非空）；manifest 解析容错（字段缺失/未知 scene 归入 general）；可选：manifest 附 `integrity` 字段（对清单体做 sha256，由构建管线写入指针文件）防半途损坏；已缓存条目离线永远可用。
- **风险 2（版本迭代与缓存一致性）**：CDN 升 version 后旧缓存作废占空间。对策：按版本分目录，新版本 manifest 生效后后台清理旧版本目录；cache.json 账本可随时删除重建。
- **风险 3（Voice Design 发布侧漂移）**：官方重新生成同一预设可能音色变化。对策：发布管线固定 seed 与 voxcpm 版本并记录在 manifest；迭代是显式动作（用户会拿到新版本音色，属预期）。
- **风险 4（方言预设质量）**：东北/粤语/川渝依赖模型的口音能力，可能「不像」。对策：验收放宽为听感可辨 + 回读通过；不达标则从 Apache-2.0 语料库（AISHELL-3 等）补免费样本替换声源（manifest 记来源与许可证）。
- **开放问题 1**：CDN base 与分发载体——`cdn.recut.video` 尚未就绪时用 GitHub Pages/Release 过渡，v1 必须先定。
- **开放问题 2**：bootstrap 清单的兜底深度——仅「id+名称」（离线列表可见但点开提示联网）还是内置 2~3 条最常用 wav（<1MB，离线真正可用）？v1 倾向前者，实现最简单。
- **开放问题 3**：manifest 是否需要签名防篡改？自托管 CDN + sha256 足够 v1；若后续 catalog 开放第三方贡献再引入签名。
- **开放问题 4**：`audio.presets` 是否上报「试听 assetId」（resolve 后自动入库为平台素材）？倾向 v1 只报缓存状态，试听走 App 私有 URL；入库仍走显式 save。

## 12. 不采纳边界（明确不做）

- **不克隆真人/网红声音**：任何 designDesc 不得指向真实自然人（含网红、配音演员）；SKILL 与 UI 文案明示。
- **不接云端音色服务**：百炼/剪映/逗哥的预置音色是云端闭源资产，仅作风格调研参考。
- **不做声音风格化参数 UI**（语速/音高滑杆）：Voice Design 描述已承担风格表达，参数化留给后续 RFC。
- **不改平台 worlds 契约**：voice_reference 证据角色已存在，本 RFC 只产出合规 asset。
- **不做多语言预设**：首批 20 个全部中文优先；英文/其他语种预设待验收链路支持后另议（见 VoxCPM RFC §12 风险 3）。
