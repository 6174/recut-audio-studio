<!--
 * [INPUT]: 依赖 audio-studio 现状（ui/src/main.tsx 的三步骤控件内嵌模型下载按钮与 VoxCPM 版本下载/运行时重试按钮、角色模态框 create/list/detail 平铺、
 *          audio.status 的 engines 结构、audio.install 的模型枚举、audio.prepare 的无参全量 bootstrap、bootstrap.py 的 --voxcpm-only 入口、
 *          background.js 的 ctx.python.prepare/run 契约、音频预设 RFC 的 design 弹框与 origin 列）
 * [OUTPUT]: 定义声音工坊「模型与环境集中管理」实施蓝图：右上角设置入口集中全部模型下载与环境安装动作（工作流步骤内只留就绪引导）；
 *          audio.prepare 增加 target 定向环境准备；声音角色模态框改为「上传参考音 / VoxCPM 设计 / 管理」三入口 + 二级模态框；
 *          角色来源徽标（clone/design/preset）与删除入口补齐
 * [POS]: rfc 的 audio-studio 设置面板与角色入口实施蓝图；获批后落到 manifest/background.js、bootstrap.py + audio_runner.py、
 *        ui/src/main.tsx + voice.tsx + types.ts + i18n.ts，并反向更新 README 与 SKILL.md
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
-->

# RFC: 模型与环境设置面板 + 声音角色双入口（集中管理下载与安装）

- 状态：**已采纳（本文件即实施蓝图）**
- 作者：Recut
- 日期：2026-09-03
- 决策范围：设置入口与面板信息架构、`audio.prepare` 定向环境准备契约、声音角色模态框交互（三入口 + 二级模态框）、工作流步骤的就绪引导降级、角色来源展示与删除
- 关联：`manifest.json`、`background.js`、`bootstrap.py`、`python/audio_runner.py`、`ui/src/main.tsx`、`ui/src/voice.tsx`、`ui/src/types.ts`、`ui/src/i18n.ts`、`README.md`、`skills/audio-studio/SKILL.md`、`rfc/2026-08-22-voxcpm-support.md`、`rfc/2026-09-02-voice-presets-and-voice-design.md`

## 1. 背景与病灶

声音工坊的能力流（转写 / 声音角色 / 配音）与「环境准备」之间的耦合方式已经不符合产品语义：

1. **下载/安装动作散落在业务工作流里**：转写步骤有模型下载按钮 + 下载源下拉；角色步骤同样；配音步骤还有 CosyVoice 下载按钮、VoxCPM 版本下载按钮、VoxCPM 运行时「重试安装」按钮和第二个下载源下拉。用户为了「让按钮变可用」要在三个不同位置做同一种事情（下载/安装），心智模型是「我在做配音，为什么要先去装一个 venv」。
2. **角色创建是单入口**：只能「上传参考音」，Voice Design 藏在克隆表单里的一个按钮中（二级弹框叠三级表单）；没有「管理已有角色」的一等入口（UI 甚至没有删除按钮，尽管 `audio.character.remove` 存在）。
3. **环境修复只能全量重跑**：`audio.prepare` 无参，CosyVoice 与 VoxCPM 环境只能一起重装（bootstrap 全量流程：官方代码归档 + 双 venv + pip），无法只修某一个专属 venv。

**目标**：

1. 右上角**设置入口** → 一个「模型与环境」面板集中管理：三个专属运行环境（主/CosyVoice/VoxCPM）+ 全部模型（5 个 ASR + CosyVoice2 + 3 档 VoxCPM）+ 下载源 + 声音预设缓存状态。业务工作流步骤内只保留**就绪状态行 + 「打开设置」引导**。
2. 声音角色模态框改为**三入口**（上传参考音 / VoxCPM 设计声音 / 管理声音角色），每个入口进入**二级模态框**。
3. `audio.prepare` 支持**定向环境准备**（`target: all | cosyvoice | voxcpm`），让「只装 VoxCPM venv」成为十秒级动作而不是全量重装。

**边界（本阶段不做）**：不改 `ready` 顶层语义（主环境 + CosyVoice 仍是 Setup 门控，见 §3 不变量）；不做预设缓存的清除操作（只读展示）；不做模型磁盘用量统计与权重删除；不改平台 service（`ctx.python.run` 已足够）。

## 2. 产品决策

### D1：右上角设置入口 + 「模型与环境」面板

- 工作台头部右上角加**齿轮按钮**；点击打开 DialogCard「模型与环境」（z-60，可叠在任一工作流模态框之上——安装完成后无需离开当前步骤）。
- 面板四个区：**运行环境**（主 / CosyVoice / VoxCPM 三行：状态徽标 + 错误 + 安装/修复动作）→ **转写模型**（5 行 ASR）→ **配音模型**（CosyVoice2 + 3 档 VoxCPM）→ **下载源**（自动 / Hugging Face / ModelScope，即时持久化）；附声音预设缓存状态（只读）。
- 工作流步骤内的下载/安装按钮与下载源下拉**全部移除**，替换为就绪状态行（✓ 已就绪 / ✗ 未就绪 +「打开设置」按钮，按目标聚焦到对应分区并滚动）。
- 按钮在 `busy`（有在途任务）时禁用；任务经既有任务中心可观察（列表 + 详情 + 日志），完成后 `audio.status` 刷新使面板行状态实时更新。

**论证**：模型/环境是**前置资源**而非工作流参数（文本、语言、风格、引擎/版本仍是步骤内参数，保留在工作流里）。「资源管理」与「任务执行」分离后，步骤控件回归纯业务语义；集中面板也天然成为 Agent 排障的可读性锚点（用户可以把面板截图交给 Agent）。

### D2：`audio.prepare` 增加 `target` 定向环境准备

```text
audio.prepare  input: { target?: "all" | "cosyvoice" | "voxcpm" }   缺省 "all"（现状行为不变）
  all       → ctx.python.prepare()（平台全量：主 venv + 锁依赖 + FFmpeg + bootstrap 全量）——Setup 引导路径专用
  cosyvoice → ctx.python.run(["python/bootstrap.py", "--target", "cosyvoice"])   （官方代码归档 + CosyVoice 专属 venv）
  voxcpm    → ctx.python.run(["python/bootstrap.py", "--target", "voxcpm"])      （VoxCPM 专属 venv，替代旧的 --voxcpm-only 语义）
```

- 平台 `ctx.python.prepare()` 不支持向 bootstrap 传参（service 侧 `pythonPrepareCommand` 无参调用），但 `ctx.python.run(args)` 以主 venv 解释器执行任意脚本并注入 `RECUT_VENV/RECUT_PYTHON/RECUT_MODELS_DIR/RECUT_APP_FILES_DIR`——定向 prepare 走 `ctx.python.run` 调用 `bootstrap.py --target`，**零 service 改动**。
- bootstrap.py 将 `--voxcpm-only` 收敛为 `--target voxcpm`（`--voxcpm-only` 保留为别名兼容），并把 CosyVoice 官方代码安装抽出为 `install_cosyvoice_code()` 供两个目标复用。
- 定向任务记入任务中心（action `prepare`，meta 带 `target`），日志沿用 `--task-log` JSON-lines 约定（bootstrap 新增最小 tee，与 audio_runner 同契约）。
- MCP/Agent 面：`target` 缺省 `all`，既有 Agent 调用零影响；需要定向修复时显式传参。

### D3：声音角色模态框 = 三入口 + 二级模态框

```text
LauncherBar「声音角色」→ 一级模态框（三张入口卡）：
┌ 上传参考音 ────────┐  5~15 秒干净人声 → 克隆可复用角色（CosyVoice 声纹 + 回读验收）
┌ VoxCPM 设计声音 ────┐  自然语言描述想要的声音，VoxCPM2 生成（就绪徽标：VoxCPM2 状态）
┌ 管理声音角色 (N) ───┐  试听 / 保存 / 删除已有角色
```

- 每个入口点击后**叠开二级模态框**（z-60，带「返回」；关闭二级回到一级入口卡）：
  - 上传参考音 → 既有两步克隆流程（素材 + 命名 → 模型 + 就绪行）；
  - VoxCPM 设计 → 设计表单（名称 + 音色描述 + 从预设起步 + 入库开关），就绪门控（VoxCPM2 权重/运行时 + ASR 回读模型；未就绪给「打开设置」引导而非安装按钮）；
  - 管理 → 角色列表（含来源徽标 克隆/设计/预设）→ 角色详情（试听 + 提示词 + 保存 + 删除，删除走两次点击确认）。
- 克隆/设计任务成功后自动切到「管理」视图展示新角色。
- 移除克隆表单内原「设计声音」按钮（设计成为独立入口）；`DesignVoiceDialog` 拆为无遮罩 `DesignVoicePanel` 供二级模态框承载。

### D4：角色来源（origin）成为一等展示维度

角色列表与详情展示 `origin` 徽标（克隆 / 设计 / 预设，来自 `audio_characters.origin` 列，voice-presets RFC D6）；配音步骤的「我的角色」行同样带来源徽标。补齐 UI 删除入口（`audio.character.remove` 已存在但 UI 从未暴露）。

## 3. 关键不变量

1. **`ready` 门控不变**：Setup 屏仍由 `audio.status.ready`（主环境 + CosyVoice）决定；进入工作台后 VoxCPM 环境/权重、ASR 权重都是**面板内可修复的可选资源**，不再阻塞工作流打开。
2. **验收纪律不变**：回读验收（≥0.85）、预设 sha256、角色三件套验收、私有产物显式入库——全部原样；本 RFC 只移动「下载/安装」动作的位置，不碰任何质量门。
3. **单一在途任务**：设置面板的动作复用 `ensureNoActiveJob` 单飞语义；`busy` 期间全部动作按钮禁用。
4. **契约向后兼容**：`audio.prepare` 不传 `target` 行为与现状一致；`audio.status` 仅**增**字段（`engines.cosyvoice2.runtimeError`）；`audio.presets`/`audio.character.design`/`audio.install` 契约不变。
5. **工作流参数留在步骤内**：引擎/版本、模型、语言、风格、文本、角色/预设选择全部仍是步骤内参数——设置面板只管「资源就绪」。

## 4. 数据与接口契约

### 4.1 `audio.prepare`（manifest 扩展）

```text
inputSchema.properties.target: enum ["all","cosyvoice","voxcpm"]   缺省 "all"
```

### 4.2 `audio.settings.set`（新增，api 面）

```text
input: { downloadSource: "automatic" | "huggingface" | "modelscope" }
行为: 复用 background 既有 audio_settings 表写入（install 时本来就会持久化），返回 { downloadSource }
```

### 4.3 `audio.status`（runner 增量字段）

```jsonc
"tts": {
  "engines": {
    "cosyvoice2": { "repository": true, "model": true, "runtime": true, "ready": true,
                    "runtimeError": null },            // 新增：worker status 失败时的人读错误
    "voxcpm": { ... 不变（runtime/runtimeError/models/ready） }
  }
}
```

主环境行直接由工作台存在性推导（进入工作台 ⇒ 主 venv/FFmpeg/Qwen 运行时就绪），runner 不新增 `environments` 块——避免与 SKILL 已引用的 `engines.*` 双信息源。

### 4.4 UI 类型（`types.ts`）

- `RuntimeStatus.tts.engines.cosyvoice2` 扩展 `repository/model/runtime/runtimeError`。
- `RuntimeStatus` 增 `presets?: { cdnReachable: boolean; cached: string[] }`（runner 既有载荷的类型化）。
- `VoiceCharacter` 增 `origin: "clone" | "design" | "preset"`（background 一直返回）。

## 5. UI 信息架构

```text
┌──────────────────────────────────────────────────────────────┐
│ 声音工坊 v1.0                                        [⚙ 设置] │  ← 新增齿轮
├──────────────────────────────────────────────────────────────┤
│ LauncherBar：转写 / 声音角色 / 配音                            │
│ 左：任务中心            右：任务详情（日志/结果/保存）           │
└──────────────────────────────────────────────────────────────┘

[⚙] → 「模型与环境」DialogCard（z-60，可叠在步骤模态框上）：
  运行环境   主环境      ✓ Python 3.11 · Whisper/Qwen3-ASR · FFmpeg   [重新安装]
             CosyVoice   ✓ 专属 venv + 官方代码                        [重新安装]
             VoxCPM      ✗ torch 版本过低…                             [安装/修复]
  转写模型   Qwen3 0.6B  ✓ 已下载 / Whisper small [下载] / …（5 行）
  配音模型   CosyVoice2  约 2.7 GB  ✓ / [下载]
             VoxCPM2     2B · 48kHz · 30 语种 · 约 5.0 GB  ✓ / [下载]
             VoxCPM1.5 / VoxCPM-0.5B …
  下载源     [自动 ▾]（自动 / Hugging Face / ModelScope，变更即持久化）
  声音预设   CDN manifest v1 · 已缓存 8/20 · 按需下载无需管理

「声音角色」Launcher 卡 → 一级模态框（三入口卡）→ 二级模态框（各入口表单/列表）
步骤内就绪行：✗ 所选模型未下载 → [打开设置]（聚焦对应分区）
```

## 6. 分阶段实施

**Phase 1 —— 后端契约**
1. `bootstrap.py`：`--target all|cosyvoice|voxcpm`（`--voxcpm-only` 别名）+ `install_cosyvoice_code()` 抽取 + `--task-log` tee。
2. `audio_runner.py`：`state()` 的 `engines.cosyvoice2` 增 `runtimeError`。
3. `background.js` + `manifest.json`：`audio.prepare` target 分支（all→`ctx.python.prepare`，定向→`ctx.python.run(bootstrap --target)` + `--task-log`）；`audio.settings.set` 新 op。

**Phase 2 —— UI**
4. `types.ts` / `i18n.ts`：类型与全量文案（zh/en）。
5. `main.tsx`：设置齿轮 + `SettingsDialog`（四分区 + 聚焦滚动）；三步骤控件移除下载/安装/下载源、换就绪行；角色模态框三入口 + 二级模态框（克隆/设计/管理）+ origin 徽标 + 删除确认；`DesignVoicePanel` 拆分。
6. `voice.tsx`：`DesignVoiceDialog` → `DesignVoicePanel`；VoicePicker 角色行加 origin 徽标。

**Phase 3 —— 文档**
7. README.md / README.en.md（界面导览 + FAQ）、SKILL.md（`target` 参数说明）、各文件 [INPUT]/[OUTPUT]/[POS] 头部、`ui/dist` 重建。

## 7. 测试与验证

- **L1（脚本级）**：`bootstrap.py --target cosyvoice|voxcpm|all` 在已就绪环境下幂等通过（venv 存在 → pip 无变更 → `pip check` + worker status）；缺 venv 时正确创建；`--voxcpm-only` 别名等价；`--task-log` 写出 JSON-lines。`audio_runner.py status` 在 CosyVoice worker 失败时 `engines.cosyvoice2.runtimeError` 非空且 `ready=false`。
- **L2（UI 手动）**：设置面板四分区状态徽标与行按钮正确（就绪/未就绪/运行中禁用）；定向安装 VoxCPM 环境成功后行翻绿；步骤内「打开设置」聚焦正确分区；角色三入口二级模态框开合/返回正常；origin 徽标与删除确认；design 未就绪门控与引导。
- **L3（端到端）**：全新环境（无 venv）→ Setup 全量 prepare → 工作台；设置面板定向重装 VoxCPM venv → 配音步骤 VoxCPM 可用；克隆/设计角色 → 管理视图可见可删；与 VoxCPM RFC §13 验收清单并跑不回归。

## 8. 风险与取舍

- **风险 1（定向 prepare 跳过主 venv 健康检查）**：`ctx.python.run` 要求主 venv ready 否则 panic——恰好是期望语义（工作台可达 ⇒ 主 venv 健康）；Setup 屏（主 venv 病态）不渲染齿轮，用户只能走全量 `ctx.python.prepare` 修复。
- **风险 2（设置面板与步骤模态框叠层过多）**：限制叠层 ≤2（步骤/一级角色框 → 二级或设置面板）；设置面板 z-60 之上不再叠加任何弹层。
- **取舍**：下载源从步骤移入面板后，「边看步骤边换源」要多一次点击——换来三步骤无资源操作、下载源单一持久化位置（此前三个步骤各存一份同义状态）。

## 9. 不采纳边界（明确不做）

- 不做**权重删除/磁盘用量管理**（模型目录仍在 `~/.recut/models/audio-studio/` 手工管理）。
- 不做**预设缓存清除 op**（面板只读展示缓存状态；清缓存 = 删 App files 目录，留给后续 RFC）。
- 不把设置面板暴露为 MCP 面（资源管理是 UI 关注点；Agent 用 `audio.status` + `audio.install` + `audio.prepare {target}` 即可）。
- 不改 **Setup 引导屏**（主环境仍是硬门控；本 RFC 的修复动作面向工作台内的可选资源）。

## 10. 实施记录

- **Phase 1（后端，已完成）**：
  - `bootstrap.py`：`--target all|cosyvoice|voxcpm`（`--voxcpm-only` 保留为别名）、`install_cosyvoice_code()` 抽取、`--task-log` JSON-lines tee（与 audio_runner 同契约）。
  - `python/audio_runner.py`：`state()` 的 `engines.cosyvoice2` 增 `runtimeError`（venv 缺失 / worker 自检失败 / 仓库未准备三种可读错误）。
  - `background.js`：`audio.prepare` 的 `target` 分支（all→`ctx.python.prepare()` 平台全量；定向→`ctx.python.run(["python/bootstrap.py","--target",...])`，零 service 改动）；新 op `audio.settings.set`（下载源持久化，复用既有 audio_settings 表）。
  - `manifest.json`：`audio.prepare` inputSchema 增 `target`；注册 `audio.settings.set`（api 面）。
- **Phase 2（UI，已完成）**：
  - `main.tsx`：头部右上角设置齿轮（busy 时禁用）；`SettingsDialog`（运行环境三行 / ASR 五行 / TTS 四行 / 下载源 / 预设状态，分区聚焦滚动）；三步骤控件移除下载/安装/下载源控件，换为就绪行 + 「打开设置」（按分区聚焦）；角色模态框一级三入口（`CharacterEntries`）+ 二级模态框（clone 两步流程 / DesignVoicePanel / 管理列表+详情）；`DialogCard` 增 `level`（z-60 叠层）与 `onBack`；`CharacterPreview` 增 origin 徽标与两步删除确认；`CharList`/`VoicePicker` 增 origin 徽标；克隆/设计任务成功后自动切到「管理」。
  - `voice.tsx`：`DesignVoiceDialog` 拆为无遮罩 `DesignVoicePanel`（就绪门控按表单形态：从预设起步零推理只需 ASR，自由描述需 VoxCPM2）；导出 `originLabelKey`。
  - `types.ts`：`RuntimeStatus.tts.engines.cosyvoice2` 扩展（repository/model/runtime/runtimeError）、`presets` 缓存状态、`VoiceCharacter.origin`。
  - `i18n.ts`：settings/characters.entry/character.origin/controls.*.missing/design.missing*/msg.preparingRuntime 等全量 zh/en 文案。
- **Phase 3（文档，已完成）**：README.md/README.en.md（界面导览 + FAQ + 从想法到成片）、SKILL.md（target 参数与「环境准备≠权重下载」纪律）、`ui/dist` 重建。
- **验证**：
  - L1：`bootstrap.py --target` 三种值 `--help` 与参数解析通过；`audio_runner.py status` 在空环境（无 venv）下正确输出 `engines.cosyvoice2.runtimeError`；在用户真实环境（voxcpm2/1.5 已下载、双引擎 venv 齐全）下 `ready:true` 且各引擎 ready 正确，**全程只读未触发任何下载**。
  - UI：`tsc --noEmit` 干净（顺手修复既有 busy 联合类型缺 `"design"` 的报错）；`vite build` 成功。
  - 待办：真实 Recut 端到端 L3（设置面板叠层交互、定向 VoxCPM 重装、角色三入口开合）待用户在 App 内实验。
- **偏离决定（来自实现）**：
  1. 主环境行由「工作台存在性」推导（进入工作台 ⇒ 主 venv 健康），runner 不新增 `environments` 块，避免与 SKILL 引用的 `engines.*` 双信息源（RFC §4.3 已按此定稿）。
  2. 角色一级模态框的 headerAction 改为只读计数徽标（原「新建角色/所有角色」切换按钮被入口卡取代）。
