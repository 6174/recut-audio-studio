<!--
 * [INPUT]: 依赖 audio-studio 现状（background.js 的 ensureNoActiveJob 全局单飞、trackJob 强关上一任务、trackedJob 只结算最新一条、
 *          audio_tasks 表已有 state 机 queued|running|… 但 queued 从未被使用——08-23 任务中心 RFC 明确预留）、
 *          audio.status 的 activeJob/activeTask 单任务契约、ui/src/main.tsx 的全局 busy 字符串与 LauncherBar「selected && running」全局徽标、
 *          平台 ShellJobManager 无并发上限（每次 ctx.python.run 即一个进程）
 * [OUTPUT]: 定义声音工坊任务并发模型实施蓝图：推理类任务（转写/建角色/设计/配音）单槽 FIFO 排队串行，
 *          环境准备（prepare）单槽排队，模型下载（install）不限并行；排队任务 enqueue 等待而非拒绝；
 *          UI 进行中状态按功能归属显示（全局 busy 降为功能级 busy + status.tasks 任务清单）
 * [POS]: rfc 的 audio-studio 任务队列与功能级状态实施蓝图；获批后落到 background.js（队列引擎）、
 *        ui/src/main.tsx + types.ts + i18n.ts（功能级状态）、manifest.json（描述性）、README 与 SKILL.md，
 *        兑现 2026-08-23-task-center-ux.md 预留的 queued 语义
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
-->

# RFC: 任务队列与并行（能并行的并行，不能并行的排队等待）

- 状态：**已采纳（本文件即实施蓝图）**
- 作者：Recut
- 日期：2026-09-03
- 决策范围：任务并发分类与调度（enqueue 而非拒绝）、`audio.status` 任务清单契约、UI 功能级进行中状态、设置面板按行禁用
- 关联：`background.js`、`ui/src/main.tsx`、`ui/src/types.ts`、`ui/src/i18n.ts`、`manifest.json`、`README.md`、`skills/audio-studio/SKILL.md`、`rfc/2026-08-23-task-center-ux.md`

## 1. 背景与病灶

现状是**全局单飞**：`ensureNoActiveJob` 在任何任务在途时直接抛错拒绝，`trackJob` 强关上一条任务，`trackedJob` 只结算最新一条。后果：

1. **无法并行发起**：克隆角色（长任务）在途时，想发起一个配音都做不到，被「已有任务正在执行」拒绝；一个 5GB 模型下载会锁死全部功能。用户预期是「能并行的并行，不能并行的排队等」，而不是「一次只能干一件事」。
2. **进行中状态张冠李戴**：UI 用一个全局 `busy` 字符串驱动全部控件与 LauncherBar 徽标（`selected && running`）——任意一个任务在途，当前打开的功能卡片就显示「进行中」，配音卡片在克隆角色时也被打上进行中标记。
3. **queued 语义闲置**：08-23 任务中心 RFC 已把 `audio_tasks.state` 设计为 `queued|running|…` 并预留 `queued` 过滤，但从未有任务真正进入 queued——表结构就绪，队列逻辑缺失。

**平台前提**（已核实）：`ShellJobManager.Start` 无并发上限，`ctx.python.run` 每次调用即一个独立进程；并发安全由应用层负责。

## 2. 决策

### D1 并发分类（资源模型）

| 类 | action | 槽位 | 理由 |
| --- | --- | --- | --- |
| 推理 `inference` | `transcribe` / `character` / `design` / `synthesize` | 1，FIFO 排队 | 全部在 MPS 上加载 torch 大模型（Qwen3-ASR / CosyVoice2 / VoxCPM 2B），并行必然 OOM |
| 环境 `environment` | `prepare` | 1，FIFO 排队 | bootstrap 会重建 venv 文件树，不能与正在该 venv 里跑推理的任务并行 |
| 下载 `install` | `install` | 不限并行 | 纯磁盘/网络（权重落 `~/.recut/models`），不占 GPU，互不冲突 |

**派发守卫**（`pumpQueue` 启动一个排队任务的必要条件）：

- 推理任务：无在途 `prepare`；且没有在途 `install` 正下载它依赖的模型——依赖集：`transcribe`/`character` → `meta.model`（ASR 回读）；`design` → `meta.model` + `voxcpm2`；`synthesize` → `meta.engine`。权重下载未完成就起推理必然加载坏文件，故排队等待下载完成。
- 环境任务：无在途（含排队）推理任务——排队中的推理稍后就要用 venv，prepare 必须等它们排空。
- 下载任务：无守卫，提交即跑。

保守性说明：不做「按模型大小动态估显存」之类的精确调度——串行是安全上界，排队体验由 UI 状态弥补（见 D4）。

### D2 队列引擎（background.js）

1. **`audio_tasks` 增列 `payload_json`**（`ensureColumn` 迁移）：存提交时的原始 op 输入，供排队任务延迟重放。
2. **提交不再拒绝**：六个提交 op（transcribe/character/design/synthesize/prepare/install）统一走 `submitJob`：
   - 校验 + 产物记录入库（`status='queued'`，失败即抛错，行为不变）；
   - 插 `audio_tasks` 行：`state='queued'`、`payload_json=原始输入`、`log_path=tasks/${id}.log`；
   - 调 `pumpQueue`；返回 `{ job: <已派发 ? 跟踪的 shell job : null>, taskId }`——`job=null` 即「已排队」。
   - `install` 特例：无槽位概念，`state` 直接 `'running'`（保持现状：立即跑）。
3. **`pumpQueue(ctx)`**（队列引擎，单进程安全）：
   1. `settleAllJobs`：对**所有**在途（`state='running'` 且有 `shell_job_id`）任务行查询平台状态，终态则 `settleOutput`（产物记录落终态 + 日志尾部真实错误）+ `noteEnvOutcome`（prepare/install）+ 关任务行。取代 `trackedJob` 的「只结算最新一条」——多任务并发下旧任务记录也能正确落终态。
   2. 按类派发：先 `environment`（守卫：无在途推理），再 `inference`（守卫见 D1）；对通过守卫的**最老** queued 行做条件认领（`update … set state='running' where id=? and state='queued'`）→ 从 `payload_json` 重放 `ctx.python.run(args)`（args 由 action + record_id + 输入确定，与提交时完全一致）→ 回填 `shell_job_id` 与产物记录 `job_id`；`ctx.python.run` 抛错则该行与记录落 `failed`。
   3. 一轮 `pumpQueue` 可连续派发多个（如两个下载——但下载不经队列；典型是一次推理 + 若干下载的混合）。
4. **`pumpQueue` 触发点**（应用层无定时器，靠轮询驱动）：`audio.status`、`audio.tasks.list`、`audio.task.get`、`audio.task.logs`、所有提交 op、`audio.cancel` / `audio.task.cancel` / `audio.resolve`。UI 在存在在途任务时 1.5s 轮询任务列表 → 队列推进延迟 ≤ 轮询间隔。
5. **`audio_jobs` 表退役**：单在途时代的产物。`trackedJob` 改为从 `audio_tasks` 派生「最新在途任务」（`state in ('queued','running') order by created_at desc limit 1`）并合成 `ActiveAudioJob` 形状（08-23 RFC 已预留此迁移方向）；`audio.job` / `audio.resolve` / `audio.cancel` 全部改走 `audio_tasks`；启动时对遗留未决 `audio_jobs` 行做一次清扫（标记 `interrupted`）。新代码不再写 `audio_jobs`（保留表结构兼容旧库）。
6. **取消**：`audio.task.cancel` 扩展支持 `queued` 行（无 shell job：直接落 `cancelled` + 产物记录落 `failed`「已取消」）；`running` 行维持 `ctx.shell.cancel`。`audio.cancel`（无 id）作用于最新在途任务。

### D3 契约变更（全部增量，向后兼容）

- `audio.status` **增 `tasks: TaskSummary[]`**：全部非终态任务（queued/running，`created_at` 升序），含 `name/meta/state/progress`。UI 功能级状态的唯一真相源。`activeJob` / `activeTask` 保留（= 最新在途，queued 任务无 shell job 时 `id=''`）。
- 提交 op 返回的 `job` 可为 `null`（= 已排队）；`taskId` 恒有。
- `audio.task.cancel` 对 queued 有效（入参不变）。
- 产物记录（transcripts/characters/syntheses）的 `status` 在排队期保持 `queued`，派发后 `running`（现有 UI 仅读 completed/failed，无破坏）。

### D4 UI 功能级状态（main.tsx）

1. **`activeTasks` 状态** ← `status.tasks`（每次 refresh 更新）。`featureState(actions)` 聚合：任一匹配任务 `running` → `"running"`；否则有 `queued` → `"queued"`；无 → `null`。
2. **控件 busy 功能化**（最小 diff：各控件内部 `busy` 判定逻辑不动，只改传参）：
   - 转写步骤 ← `featureState(["transcribe"]) ?? busy`（本地 busy：upload/save/agent）；
   - 角色克隆步骤 ← `featureState(["character"]) ?? busy`；设计面板 ← `featureState(["design"]) ?? busy`；
   - 配音步骤 ← `featureState(["synthesize"]) ?? busy`——**克隆在跑时配音按钮可用**（核心诉求）。
   - 同功能已有在途（含排队）任务时该功能主按钮禁用（每功能限一单，防重复排队）。
3. **LauncherBar 徽标按功能归属**：`running` → 绿色「进行中」+ spinner；`queued` → 琥珀「排队中」；显示在**有在途任务的功能卡**上（不再限于选中卡）。声音角色卡聚合 `character+design`。
4. **设置面板按行禁用**：每行只被自己的任务禁用（该模型的 install / 该 target 的 prepare）；下载源选择在有在途 install 时禁用；齿轮按钮不再被全局 busy 禁用。
5. **进度与日志**：`activeJob` 派生自 `activeTasks` 中最新 `running`（日志流 / 计时 / 1s 轮照旧）；纯排队无 running 时不轮日志。存在在途任务时 1.5s 轮询 `refresh`（驱动后端 pump）。
6. **终态通告**：refresh 时 diff 前后 `activeTasks`——离队任务按 action 弹消息（成功/失败/取消）；`character`/`design` 成功自动切「管理」视图（沿用现有行为）；右侧任务详情对选中任务自动载入结果（现有 effect 保留）。
7. **任务中心列表**：过滤条新增「排队中」chip（`status: "queued"`，`listTasks` 已支持）；排队行显示「排队中」徽标且可取消（`task.state.queued` 文案已在 i18n 中）。

### D5 文档

- SKILL.md：Agent 并发纪律——推理类 op 重复调用会得到 `job=null`（已排队）而非报错，用 `audio.status.tasks` / `audio.tasks.list` 查排队进度，不要自行重试；install 可并行；prepare 会在推理排空后自动执行。
- README（双语）FAQ：「为什么不能同时跑多个任务？」→ 三类资源模型 + 排队机制。

## 3. 边界（本阶段不做）

- 不按模型大小做精确资源调度（串行是安全上界）。
- 不做跨 App 任务聚合、任务重试编排、优先级抢占（FIFO）。
- Setup 引导屏维持全局 `busy`（环境未就绪前工作台不可用，无跨功能诉求）。
- 应用关闭期间：shell 任务由平台托管继续跑，但队列推进依赖下一次 op 调用（UI 轮询或编辑器 capability 轮询）——与现状「重启后 reconcile 结算」语义一致，不新增后台定时器。

## 4. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 多窗口/多调用方同时 `pumpQueue` 重复派发 | 单行条件认领（`where state='queued'`）原子化；background 单进程 |
| 下载未结束即派发推理加载坏权重 | 派发守卫按模型依赖集检查在途 install（D1） |
| 排队任务引用的素材在等待期被删 | 提交时即 `materialize` 落 App 沙箱并写入 payload；派发只用沙箱副本 |
| 旧库遗留 `audio_jobs` 未决行 | 启动清扫一次（`interrupted`）；新代码不读写 |
| UI 轮询驱动派发有 ≤1.5s 延迟 | 可接受（进度条/排队徽标掩盖）；提交 op 内同步 pump 一次，空槽立即起跑 |

## 5. 实施记录

- **Phase 1（后端，已完成）**：
  - `background.js`：并发分类常量（INFER_ACTIONS）；`audio_tasks` 增列 `payload_json`（`ensureColumn` 迁移）；`audio_jobs` 单在途账本退役（ensureSchema 启动清扫遗留未决行）；`reconcileTasks` 由 `settleAllJobs`（逐行结算：settleOutput + noteEnvOutcome + closeTaskById）取代；`trackJob` 强关语义由 `submitJob`（只写一行）+ `dispatchTask`（条件认领 → buildJobSpec 重放 → 回填 shell_job_id/job_id）取代；`pumpQueue`（settle → 环境单槽（等推理排空）→ 推理单槽（依赖守卫））由 status/tasks.list/task.get/task.logs/提交/cancel/resolve 驱动；`trackedJob` 改为从 audio_tasks 派生（queued 行 id 为空）；六个提交 op 去 `ensureNoActiveJob`、返回 `{ job: jobForTask | null, taskId }`；install 直跑（并行）；`audio.task.cancel` 支持 queued（记录落 failed「已取消」）；`audio.status` 增 `tasks` 全量非终态清单；`toTaskSummary` 增 `error/jobId/startedAt`；`listTasks` 的 running 过滤收紧为仅 `state='running'`（修复 queued 被 running 过滤误纳）。
  - `test/queue_smoke.mjs`：node:sqlite + mock 平台 ctx 驱动真实 background.js，23 项断言全部通过（单槽排队/并行下载/FIFO 派发/依赖守卫/prepare 排空等待/双路径取消/清单契约）。
- **Phase 2（UI，已完成）**：
  - `main.tsx`：`activeTasks`（← `status.tasks`）+ `featureState`/`featureBusy` 功能级聚合；LauncherBar 按卡显示「进行中/排队中」（不再全局锁、不再限于选中卡）；三个工作步骤/设计面板/角色预览的 busy 全部功能化（克隆在跑时配音按钮可用）；齿轮按钮不再被全局 busy 禁用；`SettingsDialog` 改 `activeTasks` 按行禁用（每行只被自己的 prepare/install 任务禁用，按钮文案切换为排队中）；`TaskCenter` 新增「排队中」过滤 chip（TaskRow 已天然支持 queued 徽标+取消）；存在在途任务时 1.5s 轮询 `audio.status`（驱动后端 pump）；`syncJob` 对 queued（id 空）不再清进度；提交处理器容忍 `job=null`（排队消息 + 任务面板排队占位）；`announceTaskEnd` diff 通告离队任务（按 action 弹消息，角色/设计成功切「管理」）。
  - `types.ts`：`RuntimeStatus.tasks`、`TaskSummary` 增 `error/jobId/startedAt`、`DesignCharacterResult.job` 可空。
  - `i18n.ts`：`task.filter.queued` / `msg.jobQueued` / `msg.queuedRunning` / `msg.taskCancelled` / `msg.taskFailed`（zh+en 全覆盖）。
- **Phase 3（文档/契约，已完成）**：`manifest.json`（status 增 tasks、prepare/transcribe/design 排队语义、cancel 支持 queued、audio.cancel 文案）；`SKILL.md`（Agent 并发纪律：job=null 是排队不是失败，不要重试）；README 双语（任务中心能力行 + FAQ「为什么不能同时跑多个任务」）；`ui/dist` 重建。
- **验证**：
  - L1：`node test/queue_smoke.mjs`（node:sqlite + mock 平台 ctx 驱动真实 background.js）23 项断言全部通过：单槽排队/FIFO 派发/install 并行/依赖守卫/prepare 排空等待/queued+running 双路径取消/`status.tasks` 与 `tasks.list` 过滤契约。
  - 真实环境：`audio_runner.py status` 只读验证通过（新 `tasks` 字段为纯增量，未触发任何下载）。
  - `node --check`、`tsc --noEmit`、`vite build`、manifest JSON 全部通过。
  - 待办：真实 Recut 端到端 L3（克隆在途时发起配音→排队→自动开始）待用户在 App 内验证。
- **偏离决定（来自实现）**：
  1. `listTasks` 的 `running` 过滤收紧为仅 `state='running'`（旧语义用 isActiveJob 会把 queued 误纳入「进行中」过滤——队列时代修复）。
  2. `audio_jobs` 表保留但只写清扫、不再作为结算依据（08-23 RFC 预留的退役路径）；`closeTask`（shell_job_id 匹配）由 `closeTaskById` 取代（排队行无 job id 也能关账）。
  3. `synthesize` 的 meta.characterName 从角色表补读 `name` 列（旧代码 select 漏列导致任务名一直缺角色名的隐性 bug 顺带修复）。
