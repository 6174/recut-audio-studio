<!--
 * [INPUT]: 依赖 audio-studio 现状（background.js 的任务模型 audio_jobs / audio_transcripts / audio_characters / audio_syntheses / audio_env_error、ShellJobLog 契约、trackJob/settleOutput/noteEnvOutcome 流程、ensureNoActiveJob 单在途约束；types.ts 的 ShellJob/ActiveAudioJob/TranscriptSummary/VoiceCharacter/Synthesis；main.tsx 的 Tab 三步工作流与 activeJob 轮询；以及 v2ux.html 原型的方向）
 * [OUTPUT]: 定义声音工坊「任务中心」重构方案：以统一任务账本 audio_tasks（关系表）+ 每任务日志文件 tasks/${taskId}.log（JSON-lines）替代散落的 audio_jobs 与仅返回 completed 的列表；引入 source(ai/manual)+submitted_by 来源标记、结构化 meta、created_at 日期分组、可回看的 Logs；
 *          新增 audio.tasks.list / audio.task.get / audio.task.logs / audio.task.cancel 四个 operation，并给出 main.tsx 切换到两栏任务列表 + 详情（v2ux 方向）的迁移路径
 * [POS]: rfc 的 audio-studio 任务中心实施蓝图；获批后落到 background.js、ui/src/main.tsx + types.ts + i18n.ts、manifest.json、README.md，并复用 v2ux.html 原型作为 UI 基线
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 -->

# RFC: 声音工坊「任务中心」——统一任务账本 + 持久日志（v2ux 方向）

- 状态：**草案（待评审）**
- 作者：Recut
- 日期：2026-08-23
- 决策范围：任务数据模型（统一账本 + 日志）、来源标记（AI/手动）、operation 契约（list/get/logs/cancel）、UI 主面板从 Tab 三步切换为两栏任务列表 + 详情、分阶段实施与边界
- 关联：`background.js`、`ui/src/main.tsx`、`ui/src/types.ts`、`ui/src/i18n.ts`、`manifest.json`、`README.md`、原型 `ui/v2ux.html`、既有 RFC `2026-08-22-voxcpm-support.md`

## 1. 背景与病灶

当前 UI 原型（`ui/v2ux.html`）的方向是：**主面板 = 任务列表（按日期分组、带来源与状态徽标、可回看 Logs），点击任务在右侧详情看 meta + 日志；核心操作收成顶部小按钮弹框**。但对照真实后端（`background.js` + `types.ts`），有四个结构性缺口让这个方向无法落地：

### 1.1 没有统一任务历史，只有「单条在途 job + 已完成产物」
- `audio_jobs` 表只存**一条**未结算的 job：`select ... where resolved_at = '' order by started_at desc limit 1`（`background.js:117`）。一旦 `resolve`，该行被标记 `resolved_at` 后从视图消失——**历史不留存**。
- `audio_transcripts` / `audio_characters` / `audio_syntheses` 的列表 op（`transcripts`/`characters`/`syntheses`）都带 `where status = 'completed'`（`background.js:320,425,500`）过滤。**失败、排队、进行中的记录对列表不可见**，只在某些详情 op 里偶发补错误文案。
- 结果：v2ux 要的「所有任务一个列表、按日期分组、失败也看得到」在真实数据层不存在；转写/角色/配音是**三张互不相通的表**。

### 1.2 没有来源（AI / 手动）标记
没有任何字段记录「这条任务是 AI（agent / MCP / 其他 App 经 capability 调用）提交的，还是人在 UI 手动提交的」。v2ux 的 `AI` / `手动` 徽标与「按来源过滤」无从填充。`background.js` 的所有 op 既不接收也不存储 `source`。

### 1.3 日志不持久化，任务结束后即丢失
- `ShellJobLog` 契约是 `{ jobId, sequence, text }`（`types.ts:15`）——**没有时间戳、没有等级（info/warn/error）**。
- 日志只在轮询时从平台取片段：`ctx.shell.logs(record.job_id).slice(-80)`（`background.js:110,339`），平台 shell 日志在 job 结算后可能被回收。
- 唯一持久化日志是 `audio_env_error`（仅 `prepare`/`install` 失败，`background.js:172-195`），且是 JSON blob 而非结构化行。
- 结果：v2ux 详情面板「日志 Logs」要展示带日期、分级、可回看的记录，真实后端给不出。

### 1.4 没有统一的任务 meta
任务类型/引擎/模型/语言/角色/素材/体积等散落在三张表的不同列，没有一处能结构化为「任务信息」网格（v2ux 的 `meta-grid`）。`audio_jobs` 仅存 `action/record_id/started_at`。

### 1.5 目标与边界
引入**统一任务账本 `audio_tasks`**（关系表，承载主列表/过滤/分组）与**每任务日志文件 `tasks/${taskId}.log`**（JSON-lines，承载可回看 Logs），把现有 5 类 action（prepare/install/transcribe/character/synthesize）全部纳入同一生命周期记录；补 `source`+`submitted_by`、结构化 `meta`、`created_at`；新增只读/控制 operation 支撑任务中心 UI。UI 主面板从 Tab 三步切换为 v2ux 两栏。

**边界（本阶段不做）**：不解除 `ensureNoActiveJob` 的单在途约束（同一时刻仍一个运行任务；v2ux 原型也只展示一个 running，保持一致）；不做并发多 job、任务重试编排、跨 App 任务聚合（仅本 App 内）。`model 下载 / env 安装` 不新增独立 launcher（与现状一致、按需出现）。

## 2. 数据契约：统一任务账本

### 2.1 `audio_tasks`（替代并扩展 `audio_jobs`）
```sql
create table if not exists audio_tasks (
  id            text primary key,            -- 稳定 task_id（沿用 outputID()）
  action        text not null,               -- prepare|install|transcribe|character|synthesize
  record_id     text not null default '',    -- 关联产物 id（transcript/character/synthesis 的 id；prepare/install 为 ''）
  source        text not null default 'manual', -- 'ai' | 'manual'
  submitted_by  text not null default '',    -- 'user:<id>' | 'agent:<appId>' | ''
  state         text not null default 'queued', -- queued|running|completed|failed|cancelled|interrupted
  progress      integer not null default 0,  -- 0..100，非进行中置 0/100
  meta_json     text not null default '{}',  -- 结构化任务信息（见 §2.3）
  log_path      text not null default '',    -- 任务日志文件路径 tasks/${id}.log（见 §2.2）
  error         text not null default '',
  created_at    text not null,               -- 提交时刻（用于日期分组）
  started_at    text not null default '',    -- 真实开始运行时刻
  resolved_at   text not null default ''     -- 终态时刻；'' = 仍在途
);
create index if not exists audio_tasks_created on audio_tasks(created_at desc);
create index if not exists audio_tasks_active on audio_tasks(state);
```
> 迁移：保留 `audio_jobs` 读取兼容一段时间，新代码统一写 `audio_tasks`；`trackJob` 改为写 `audio_tasks` 并维护 `state`。「当前在途任务」查询改为 `where state in ('queued','running') order by created_at desc limit 1`，语义等价于旧的 `audio_jobs where resolved_at=''`。

### 2.2 任务日志文件 `tasks/${taskId}.log`（替代 `audio_task_logs` 表）

> 决策：日志**不用表，用文件**。理由——(1) `background.js` 没有写文件 API，只有 `ctx.files.readText/url`；现有产物全是「**runner(python) 写磁盘、background 只读/暴露 URL**」（`background.js:300-309,356,386,474` + `audio_runner.py` 的 `sf.write`）。让 runner 顺手把日志 append 进文件，完全贴合这套惯例，无需新增任何写能力。(2) 日志天然 append-only，没有按 `(task_id, sequence)` 去重/upsert 的需求，表反而是负担。(3) 人类可读、易调试、易按需截断，生命周期与任务产物同目录（清理时一并删）。

**格式：JSON-lines（每行一条）**，每条带时间戳与等级：
```jsonc
{"ts":"2026-08-22T14:29:10Z","level":"info","message":"拉取 VoxCPM2 专属 venv 运行环境…"}
{"ts":"2026-08-22T14:31:05Z","level":"info","message":"下载 cosyvoice 官方代码… 62%"}
{"ts":"2026-08-22T14:32:01Z","level":"warn","message":"modelscope 连接较慢，自动回退镜像"}
```
- 路径：`tasks/${taskId}.log`，与 `transcripts/${id}.srt`、`syntheses/${id}.wav` 同处 App 私有文件区；`audio_tasks.log_path` 存该路径（见 §2.1 列扩展）。
- **写入方**：runner。给 `audio_runner.py`（及 `tts_runner.py` / `voxcpm_runner.py`）加 `--task-log tasks/${taskId}.log`；它把现在 `print(f"[audio] …", flush=True)` 的每一行**同时 append 成 JSON-lines**（可直接沿用已有 `[audio]` 前缀解析出 level，或显式 `print(json.dumps(...))`）。stdout 仍照旧（平台 `ctx.shell.logs` 仍可实时拿，用于即时进度）。
- **读取方**：`audio.task.logs` 用 `ctx.files.readText(log_path)` 取全文，按行 `JSON.parse`，支持 `cursor`（行号/字节偏移）+ `limit` 分页，可选 `level` 过滤；无日志文件时返回空数组。
- **等级推断**：沿用 §2.1 关键词启发（warn/错误/失败→warn/error，完成/就绪/校验通过→ok，其余 info），由 runner 在写文件时打标，后台读取不再需要重新推断。

### 2.3 `meta_json` 结构（按 action 不同字段可选）
```jsonc
{
  "type": "转写" | "配音合成" | "声音角色" | "ASR 模型" | "TTS 模型" | "运行环境",
  "engine": "cosyvoice2" | "voxcpm2" | "voxcpm1.5" | "voxcpm-0.5b" | "",   // 配音/环境
  "model":  "whisper-large-v3" | "qwen3-asr-1.7b" | "voxcpm2" | "",          // 转写/模型
  "language": "auto" | "zh" | "en" | "",
  "characterId": "v-77" | "",
  "characterName": "晓琳" | "",
  "sourceAssetId": "a-2291" | "",
  "sourceKind": "audio" | "video" | "",
  "sizeGb": 5.0 | null,                  // 模型下载
  "durationSec": 1102 | null             // 转写/合成时长
}
```
> 字段与现有 `audio_transcripts / audio_syntheses / audio_characters` 的列一一对应，落库时直接从对应 record 抽取，不引入新的真相源。

## 3. Operation 契约

### 3.1 新增（任务中心只读 / 控制面）
| operation | 入参 | 返回 | 用途 |
|---|---|---|---|
| `audio.tasks.list` | `{ source?, status?, action?, cursor?, limit? }` | `{ tasks: TaskSummary[], nextCursor? }` | 任务中心主列表（v2ux 左栏）；`TaskSummary` 含 `id, action, name, source, submittedBy, state, progress, createdAt, meta（摘要）, lastLog?` |
| `audio.task.get` | `{ id }` | `{ ...task, meta, artifact? }` | 详情：完整 meta + 关联产物摘要（转写 SRT/JSON URL、角色 sampleURL、合成 outputURL） |
| `audio.task.logs` | `{ id, cursor?, limit? }` | `{ logs: { ts, level, message }[], nextCursor? }` | Logs 面板；进行中时 UI 轮询此 op 追加 |
| `audio.task.cancel` | `{ id }` | `{ cancelled, id }` | 通用取消（按 task_id 找 shell job 取消，替代散落的取消逻辑） |

- `source` 过滤枚举 `'ai'|'manual'`；`status` 枚举 `running|queued|done|failed`（映射 `state`，`done`=`completed`）。
- `TaskSummary.name` 由 `action + meta` 渲染（如 `转写：产品发布.mp4`、`下载 VoxCPM2 权重`、`安装 VoxCPM2 运行环境`），与 v2ux mock 的 `name` 字段对齐。

### 3.2 既有 op 的改造（写入账本 + 来源）
- **所有创建类 op**（`audio.transcribe` / `audio.character.create` / `audio.synthesize` / `audio.install` / `audio.prepare`）增加**可选入参** `source`（默认 `'manual'`）、`submittedBy`（默认 `''`）。
  - 人在 UI 提交 → 不传或传 `{source:'manual', submittedBy:'user:'+userId}`。
  - 其他 App / agent / MCP 经 capability 调用 → 传 `{source:'ai', submittedBy:'agent:recut-editor'}` 等。
  - 落库：写 `audio_tasks`（state 随 job 推进更新），并从 record 抽取 `meta_json`。
- **轮询类 op**（`audio.status` / `audio.transcript` / `audio.character.complete` / `audio.synthesis.complete`）在推进 job 状态时，更新 `audio_tasks.state/progress/resolved_at`，并刷新 `audio_tasks.log_path`。日志本身由 **runner 直接 append 到 `tasks/${taskId}.log`**（见 §2.2），后台只读、不负责写。
- `audio.status` 的返回把 `activeJob` 改名为 `activeTask`（结构对齐 `audio.task.get`），旧字段保留一个版本以兼容。
- `audio.cancel` 改为委托 `audio.task.cancel`；其余散落取消逻辑收敛到一处。

### 3.3 日志落盘时机（关键，保证「结束后仍可回看」）
- **创建时**：写 `audio_tasks` 一行（`state='queued'`、`log_path='tasks/${id}.log'`），并把 `log_path` 透传给 runner 的 `--task-log`。
- **运行中**：runner 边跑边把每条进度 append 到 `tasks/${id}.log`（JSON-lines）。后台轮询只更新 `audio_tasks.state/progress`，不碰日志文件。
- **终态**：runner 写末条 `ok/error` 行；后台置 `audio_tasks` 终态 + `resolved_at`。
- 这样即使平台回收了 `ctx.shell.logs` 的 stdout，`tasks/${id}.log` 已是权威副本，`audio.task.logs` 直接回读文件即可。

## 4. UI 迁移：从 Tab 三步到两栏任务中心

以 `ui/v2ux.html` 为基线，把 `ui/src/main.tsx` 的现状（Tab 三步工作流 `transcribe|characters|synthesize` + `activeJob` 轮询 + 历史小卡片）重构为：

1. **顶栏 launcher 条**：`转写 / 建角色 / 配音 / 素材库` 四个小按钮（对应 v2ux `launch-bar`），点击弹框走既有 `audio.transcribe / character.create / synthesize` op，提交成功即写入一条 `audio_tasks`（source 默认 manual）。`下载模型 / 安装环境` **不单独成入口**，保留现状「按需出现」（如转写缺模型时提示安装，安装本身也落一条 `audio_tasks`）。
2. **左栏 = 任务列表**：`audio.tasks.list` 渲染，按 `created_at` 日期分组（v2ux `day-group`），每条带 `AI/手动` 来源徽标 + 状态徽标 + 进行中进度条。`全部 / 进行中 / AI / 手动` 过滤映射到 list 的 `source/status` 入参。
3. **右栏 = 任务详情**：选中后 `audio.task.get` 取 meta 渲染 `meta-grid`，`audio.task.logs` 渲染 Logs 面板（进行中时按 `cursor` 行号增量轮询追加同一文件）。失败任务显示 `error` 与末段 `error` 级日志。
4. **类型契约更新**：`types.ts` 新增 `TaskSource`、`TaskState`、`TaskSummary`、`TaskLog`、`TaskMeta`，`ActiveAudioJob` 的 `logs: ShellJobLog[]` 从 `{jobId,sequence,text}` 演进为带 `ts/level` 的结构（向后兼容旧字段）。

> 数据连线：launcher 提交 → 既有 op 返回 `job` + 产物 id → UI 立即 `audio.tasks.list` 刷新列表（新任务置顶）→ 对 running 任务轮询 `audio.task.logs` + `audio.task.get` 直到 `state` 终态。

## 5. 分阶段实施
- **Phase 0 — Schema**：`audio_tasks` 建表（含 `log_path`）；`ensureSchema` 扩展。
- **Phase 1 — 账本写入 + 日志文件**：`trackJob`/`settleOutput`/`noteEnvOutcome` 改为写 `audio_tasks` 并维护 state；所有创建类 op 接收 `source/submittedBy` 并抽取 `meta_json`；给三个 runner 加 `--task-log` 参数，把进度 append 成 JSON-lines 到 `tasks/${id}.log`（保留 stdout 以兼容 `ctx.shell.logs` 实时进度）。
- **Phase 2 — 新 operation**：`audio.tasks.list` / `audio.task.get` / `audio.task.logs`（读 `log_path` 文件、按行解析分页）/ `audio.task.cancel`；`audio.status` 返回 `activeTask`；`audio.cancel` 委托新 cancel。
- **Phase 3 — UI v2**：`main.tsx` 切两栏（复用 v2ux.html 结构与样式 token）；launcher 弹框；详情 Logs 轮询同一日志文件。
- **Phase 4 — 兼容清理**：弃用 `audio_jobs` 读取、移除 `activeJob`、更新 `README.md` 与 `SKILL.md`、i18n 文案补全。

## 6. 验证
- **后端单测**：创建 5 类 action 各一条，断言 `audio_tasks` 行存在、`log_path='tasks/${id}.log'` 存在、state 随轮询推进；`tasks/${id}.log` 为合法 JSON-lines 且每行带 `ts/level`；结算后 `audio.task.logs` 仍可回看（即便 mock 回收 shell 日志）。
- **来源**：agent 传 `source:'ai'` 与 UI 不传，断言 `audio.tasks.list({source:'ai'|'manual'})` 过滤正确，徽标映射正确。
- **失败可见**：构造 failed 转写，断言 `audio.tasks.list` 能列出该失败任务（不再被 `where status='completed'` 隐藏），详情展示 error + 末段 error 日志。
- **不回归**：`audio.transcripts/characters/syntheses`（产物列表）行为不变；`ensureNoActiveJob` 单在途约束不变；既有 capability 调用方无需改动（新增入参可选）。

## 7. 风险与未决
- **日志等级推断**依赖关键词启发式，中文 runner 文案变动可能漏判；Phase 2(b) 推动 runner 直接吐结构化 JSON 行为长期解法。
- **`meta_json` 摘要命名**（如 `name` 渲染）需要 i18n 文案，暂用中文 key，Phase 4 收敛双语。
- 跨 App 任务聚合（agent 跨多个 App 的统一任务流）不在本 RFC 范围，留待平台级 task 服务。
