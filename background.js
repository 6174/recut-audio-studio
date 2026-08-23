/*
 * [INPUT]: 依赖 ctx.sqlite 保存模型下载源、转写/角色/合成记录，ctx.media 复制/显式导入素材，ctx.files 生成私有预览 URL，ctx.python 与 ctx.shell 执行可观察本地任务
 * [OUTPUT]: 注册环境检查、Whisper/Qwen 模型安装、转写、通过参考音与声纹验收的声音角色创建、配音合成（CosyVoice 或 VoxCPM 引擎/版本可选）、历史与用户确认入库 operation；转写可保存为源声音 + SRT + JSON 的 platform transcript 素材。audio.transcribe 扩了 saveToLibrary 开关（默认 false=私有产物不自动入库；true=终态懒入库为全局 transcript 素材并幂等去重，一次能力调用完成转写+入库）。转写/列表/详情/状态 op 已标记 capability，可被其他 App 经 ctx.capabilities.invoke 复用。
 * [POS]: audio-studio 的唯一业务后端；声音角色须通过质量验收，未选角色时使用 CosyVoice 官方默认声音进入 TTS，输出先停留在 App 文件沙箱，绝不生成时自动创建素材库 Asset（除 saveToLibrary:true 的显式授权）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

const WHISPER_MODELS = ["whisper-small", "whisper-medium", "whisper-large-v3"];
const QWEN_MODELS = ["qwen3-asr-0.6b", "qwen3-asr-1.7b"];
const ASR_MODELS = new Set([...WHISPER_MODELS, ...QWEN_MODELS]);
const VOXCPM_MODELS = ["voxcpm2", "voxcpm1.5", "voxcpm-0.5b"];
const ENGINES = new Set(["cosyvoice2", ...VOXCPM_MODELS]);
const DOWNLOAD_SOURCES = new Set(["automatic", "huggingface", "modelscope"]);
const KINDS = new Set(["audio", "video"]);
const LANGUAGES = new Set(["auto", "zh", "en"]);
const STYLES = new Set(["neutral", "calm", "excited", "gentle"]);
const ACTIONS = new Set(["prepare", "install", "transcribe", "character", "synthesize"]);
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

const RECORD_TABLES = {
  transcribe: "audio_transcripts",
  character: "audio_characters",
  synthesize: "audio_syntheses",
};

function value(input, name) { return String(input[name] || "").trim(); }
function outputID() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

// 任务中心：每任务日志文件路径（与 transcripts/${id}.srt 同处 App 私有文件区）。
function taskLogPath(taskID) { return `tasks/${taskID}.log`; }

// 由 action + meta 渲染列表展示名（与 v2ux 原型的 name 字段对齐）。
function taskName(action, meta) {
  const m = meta || {};
  if (action === "transcribe") return `转写：${m.sourceAssetId || ""}`.trim();
  if (action === "character") return `创建声音角色：${m.characterName || ""}`.trim();
  if (action === "synthesize") return `配音：${m.characterName || "默认音"}`;
  if (action === "install") return `下载 ${m.model || ""}`.trim();
  if (action === "prepare") return "安装运行环境";
  return action;
}

// 关闭一条任务的账本行（终态）。按 shell_job_id 匹配，因为调用方拿到的 record.job_id 是 shell 任务 id，
// 而 audio_tasks 的行主键是 App 自己的 task id（id），二者不同列。
function closeTask(ctx, shellJobID, state, error) {
  if (!shellJobID) return;
  ctx.sqlite.execute("update audio_tasks set state = ?, error = ?, resolved_at = ? where shell_job_id = ?", [state, error || "", new Date().toISOString(), shellJobID]);
}

// 对账：把账本里仍标记 running/queued、但其底层 shell 任务已终态（或不可用）的行，一并落到终态。
// 支撑「任务即主面板」，避免已结束任务长期停留在「进行中」。
function reconcileTasks(ctx) {
  ensureSchema(ctx);
  const actives = ctx.sqlite.query("select id, shell_job_id from audio_tasks where state in ('queued','running')");
  for (const row of actives) {
    if (!row.shell_job_id) continue;
    let status = "";
    try { status = shellJobStatus(ctx.shell.status(row.shell_job_id)); }
    catch (_) { status = "interrupted"; }
    if (status === "interrupted" || isTerminalJob(status) || (status && !isActiveJob(status) && !isTerminalJob(status))) {
      const finalState = status === "completed" ? "completed" : (status === "interrupted" ? "interrupted" : "failed");
      closeTask(ctx, row.shell_job_id, finalState, status === "interrupted" ? "任务状态不可恢复" : "");
    }
  }
}

// 任务中心主列表（audio.tasks.list）：统一账本任务 + 已有产物的历史快照，合并为「任务记录」主面板。
// 历史产物（transcripts/characters/syntheses 的 completed 记录）作为已完成任务并入，
// 让「历史」与「执行日志」全部收敛到任务列表，而不再另设历史面板。
function listTasks(ctx, input = {}) {
  ensureSchema(ctx);
  trackedJob(ctx); // 结算当前在途任务（settleOutput + closeTask）
  reconcileTasks(ctx); // 对账所有 running/queued 行的实际终态，让历史任务不再停留在「进行中」
  migrateLegacyTasks(ctx); // 一次性把既有产物并入账本；此后 audio_tasks 是唯一真相源
  const source = value(input, "source");
  const status = value(input, "status");
  const action = value(input, "action");
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);

  const jobs = ctx.sqlite.query("select id, action, record_id, source, submitted_by, state, progress, meta_json, created_at from audio_tasks").map(toTaskSummary);
  const all = jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const filtered = all.filter((task) => {
    if (source === "ai" || source === "manual") { if (task.source !== source) return false; }
    if (action && ACTIONS.has(action) && task.action !== action) return false;
    if (status === "running") { if (!isActiveJob(task.state)) return false; }
    else if (status === "queued") { if (task.state !== "queued") return false; }
    else if (status === "done") { if (task.state !== "completed") return false; }
    else if (status === "failed") { if (task.state !== "failed") return false; }
    return true;
  });
  const page = filtered.slice(0, limit);
  return { tasks: page, nextCursor: filtered.length > limit ? filtered[limit - 1].createdAt : null };
}

// 一次性迁移：把既有产物表（transcripts/characters/syntheses 的 completed 记录）并入 audio_tasks 账本，
// 让 audio_tasks 成为任务列表的唯一真相源（不再在读取期做历史快照双写）。幂等：已有账本行则跳过。
// 适用于无历史用户的新产品；仅作为启动兜底，迁移后新任务只写 audio_tasks + 对应产物表。
function migrateLegacyTasks(ctx) {
  ensureSchema(ctx);
  const insert = (action, recordId, meta, createdAt) => {
    const exists = ctx.sqlite.query("select 1 from audio_tasks where action = ? and record_id = ?", [action, recordId]);
    if (exists.length) return;
    ctx.sqlite.execute("insert into audio_tasks (id, shell_job_id, action, record_id, source, submitted_by, state, progress, meta_json, log_path, error, created_at, started_at, resolved_at) values (?, '', ?, ?, 'manual', 'user', 'completed', 100, ?, '', '', ?, ?, ?)", [`lt-${recordId}`, action, recordId, JSON.stringify(meta), createdAt, createdAt, createdAt]);
  };
  ctx.sqlite.query("select id, source_asset_id, source_kind, model, language, duration, created_at from audio_transcripts where status = 'completed'").forEach((row) => insert("transcribe", row.id, { type: "转写", model: row.model, language: row.language, sourceAssetId: row.source_asset_id, sourceKind: row.source_kind, durationSec: row.duration }, row.created_at));
  ctx.sqlite.query("select id, name, model, created_at from audio_characters where status = 'completed'").forEach((row) => insert("character", row.id, { type: "声音角色", model: row.model, characterName: row.name }, row.created_at));
  ctx.sqlite.query("select id, character_id, engine, created_at from audio_syntheses where status = 'completed'").forEach((row) => insert("synthesize", row.id, { type: "配音合成", engine: row.engine || "cosyvoice2", characterId: row.character_id }, row.created_at));
}

function toTaskSummary(task) {
  let meta = {};
  const raw = task.meta_json ?? task.meta;
  if (typeof raw === "string") { try { meta = JSON.parse(raw); } catch (_) { /* keep empty */ } }
  else if (raw && typeof raw === "object") { meta = raw; }
  return { id: task.id, action: task.action, name: taskName(task.action, meta), recordId: task.recordId || task.record_id || "", source: task.source, submittedBy: task.submittedBy || task.submitted_by || "", state: task.state, progress: task.progress, createdAt: task.createdAt || task.created_at, meta };
}

// 任务中心详情（audio.task.get）。
function getTask(ctx, input) {
  ensureSchema(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id, action, record_id, source, submitted_by, state, progress, meta_json, log_path, error, created_at, started_at, resolved_at from audio_tasks where id = ?", [id]);
  if (!rows.length) throw new Error("Audio task was not found.");
  const row = rows[0];
  let meta = {};
  try { meta = JSON.parse(row.meta_json || "{}"); } catch (_) { /* keep empty */ }
  return { id: row.id, action: row.action, name: taskName(row.action, meta), recordId: row.record_id, source: row.source, submittedBy: row.submitted_by, state: row.state, progress: row.progress, meta, logPath: row.log_path, error: row.error, createdAt: row.created_at, startedAt: row.started_at, resolvedAt: row.resolved_at };
}

// 日志等级推断（关键词启发式）。
function inferLogLevel(message) {
  if (/失败|错误|不可用|异常|error|fail/i.test(message)) return "error";
  if (/完成|就绪|校验通过|已下载|已结束|成功|done|ok/i.test(message)) return "ok";
  if (/较慢|回退|等待|重试|进行|downloading|download/i.test(message)) return "warn";
  return "info";
}

// 任务日志（audio.task.logs）：任务运行时把平台的实时 shell 日志 stream 到该任务；
// 终态后回退读 tasks/${id}.log 的 JSON-lines，保证「结束后仍可回看」。
function readTaskLogs(ctx, input) {
  ensureSchema(ctx);
  trackedJob(ctx); // 结算在途任务，保证读取详情时状态与日志同步落到终态。
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select log_path, shell_job_id, state from audio_tasks where id = ?", [id]);
  if (!rows.length) return { logs: [], nextCursor: null }; // 历史产物快照任务无随任务日志，返回空。
  const limit = Math.min(Math.max(Number(input.limit) || 200, 1), 500);
  const from = Number(input.cursor) || 0;

  // 运行中：直接 stream 平台 shell 日志（实时、逐行），不依赖文件写入是否滞后。
  if (isActiveJob(rows[0].state) && rows[0].shell_job_id) {
    let live = [];
    try { live = ctx.shell.logs(rows[0].shell_job_id) || []; } catch (_) { live = []; }
    const all = live.map((entry) => {
      const text = String(entry.text || "").trim();
      return { index: entry.sequence || 0, ts: "", level: inferLogLevel(text), message: text };
    });
    // UI 每次都整体替换日志列表，直接返回最新窗口即可（不做增量去重）。
    return { logs: all.slice(-limit), nextCursor: null };
  }

  // 终态：优先读持久文件（JSON-lines，带 ts/level）；文件为空时回退到平台 shell 日志，保证日志不丢失。
  const logPath = rows[0].log_path || taskLogPath(id);
  let raw = "";
  try { raw = ctx.files.readText(logPath); } catch (_) { raw = ""; }
  let all = raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      const entry = JSON.parse(line);
      return { index, ts: entry.ts || "", level: entry.level || "info", message: entry.message || "" };
    } catch (_) { return { index, ts: "", level: "info", message: line }; }
  });
  if (!all.length && rows[0].shell_job_id) {
    let live = [];
    try { live = ctx.shell.logs(rows[0].shell_job_id) || []; } catch (_) { live = []; }
    all = live.map((entry) => {
      const text = String(entry.text || "").trim();
      return { index: entry.sequence || 0, ts: "", level: inferLogLevel(text), message: text };
    });
  }
  const page = all.slice(from, from + limit);
  return { logs: page, nextCursor: from + limit < all.length ? from + limit : null };
}

// 平台通过 ctx.locale 提供 "zh" 或 "en"，其余情况回退中文。
function locale(ctx) { return String(ctx?.locale || "").toLowerCase() === "en" ? "en" : "zh"; }
function tr(ctx, zh, en) { return locale(ctx) === "en" ? en : zh; }
// TODO(i18n): 剩余仍为英文的校验/状态文案（如 "assetId, kind, model and language are required"、
// "Audio transcript was not found."、"kind must be transcript, synthesis or character" 等）已在
// 平台与界面层表现为英文；如需随 ctx.locale 双语，后续在此统一收敛为 tr(ctx, ...)。

function ensureSchema(ctx) {
  ctx.sqlite.execute("create table if not exists audio_transcripts (id text primary key, source_asset_id text not null, source_kind text not null, model text not null, language text not null, srt_path text not null, json_path text not null, audio_path text not null default '', saved_asset_id text not null default '', duration real not null default 0, created_at text not null, job_id text not null default '', status text not null default 'queued', error text not null default '')");
  ctx.sqlite.execute("create table if not exists audio_characters (id text primary key, name text not null, model text not null, sample_path text not null, sample_asset_id text not null default '', prompt_text text not null default '', created_at text not null, job_id text not null default '', status text not null default 'queued', error text not null default '')");
  ctx.sqlite.execute("create table if not exists audio_syntheses (id text primary key, character_id text not null, text text not null, style text not null default 'neutral', output_path text not null, mime_type text not null, saved_asset_id text not null default '', created_at text not null, job_id text not null default '', status text not null default 'queued', error text not null default '')");
  ctx.sqlite.execute("create table if not exists audio_jobs (job_id text primary key, action text not null, record_id text not null default '', started_at text not null, resolved_at text not null default '')");
  // 统一任务账本（任务中心主列表 / 详情的来源）；日志走文件 tasks/${id}.log，不在此表存行。
  ctx.sqlite.execute("create table if not exists audio_tasks (id text primary key, shell_job_id text not null default '', action text not null, record_id text not null default '', source text not null default 'manual', submitted_by text not null default '', state text not null default 'queued', progress integer not null default 0, meta_json text not null default '{}', log_path text not null default '', error text not null default '', created_at text not null, started_at text not null default '', resolved_at text not null default '')");
  ctx.sqlite.execute("create index if not exists audio_tasks_created on audio_tasks(created_at desc)");
  ctx.sqlite.execute("create index if not exists audio_tasks_active on audio_tasks(state)");
  ctx.sqlite.execute("create table if not exists audio_settings (key text primary key, value text not null)");
  ctx.sqlite.execute("create table if not exists audio_env_error (id integer primary key check (id = 1), job_id text not null, action text not null, error text not null, logs text not null, updated_at text not null)");
  ensureColumn(ctx, "audio_transcripts", "audio_path", "text not null default ''");
  ensureColumn(ctx, "audio_transcripts", "saved_asset_id", "text not null default ''");
  ensureColumn(ctx, "audio_transcripts", "save_to_library", "integer not null default 0");
  ensureColumn(ctx, "audio_syntheses", "engine", "text not null default 'cosyvoice2'");
}

function ensureColumn(ctx, table, column, definition) {
  const columns = ctx.sqlite.query(`pragma table_info(${table})`);
  if (columns.some((row) => String(row.name) === column)) return;
  ctx.sqlite.execute(`alter table ${table} add column ${column} ${definition}`);
}

function downloadSource(ctx) {
  ensureSchema(ctx);
  const rows = ctx.sqlite.query("select value from audio_settings where key = 'download_source'");
  return DOWNLOAD_SOURCES.has(rows[0]?.value) ? rows[0].value : "automatic";
}

function setDownloadSource(ctx, source) {
  if (!DOWNLOAD_SOURCES.has(source)) throw new Error("download source must be automatic, huggingface or modelscope");
  ctx.sqlite.execute("insert into audio_settings (key, value) values ('download_source', ?) on conflict(key) do update set value = excluded.value", [source]);
}

function parseProcess(result, ctx) {
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] || "{}";
  let payload;
  try { payload = JSON.parse(last); } catch (_) { payload = { ready: false, error: String(result.stdout || result.error || tr(ctx, "Python 未返回状态数据。", "Python did not return a status payload.")) }; }
  if (Number(result.exitCode) !== 0) payload.error = payload.error || String(result.stdout || result.error || tr(ctx, "Python 进程执行失败。", "Python process failed."));
  return payload;
}

function run(ctx, args, timeoutSeconds) {
  // ------------------------------
  // Shell 会在注入 PATH 前解析命令；必须显式使用平台给出的 venv Python。
  // 同步状态检查与异步推理由此共享同一套 qwen-asr 依赖。
  // ------------------------------
  const shell = '"$RECUT_PYTHON" python/audio_runner.py "$@"';
  return parseProcess(ctx.shell.exec({ command: "sh", args: ["-eu", "-c", shell, "audio-runner", ...args], environment: "audio-studio", timeoutSeconds }), ctx);
}

function shellJobID(job) { return String(job.id || job.ID || "").trim(); }
function shellJobStatus(job) { return String(job.status || job.Status || "").trim(); }
function shellJobError(job) { return String(job.error || job.Error || "").trim(); }
function isActiveJob(status) { return ACTIVE_JOB_STATUSES.has(status); }
function isTerminalJob(status) { return TERMINAL_JOB_STATUSES.has(status); }
function outputStatus(status) { return status === "completed" ? "completed" : "failed"; }

function settleOutput(ctx, action, recordID, job, jobID = "") {
  if (!recordID || !isTerminalJob(job.status)) return;
  const table = RECORD_TABLES[action];
  if (!table) return;
  const detail = String(job.error || job.status || "failed");
  let errorText = detail;
  // 失败时把 shell job 日志尾部的真实原因存进记录，避免 UI 只看到平台笼统的 "exit status 1"。
  if (job.status === "failed" && jobID) {
    try {
      const meaningful = meaningfulError(ctx, ctx.shell.logs(jobID).slice(-80), detail);
      if (meaningful) errorText = meaningful;
    } catch (_) { /* 日志不可读时保留 detail */ }
  }
  ctx.sqlite.execute(`update ${table} set status = ?, error = ? where id = ?`, [outputStatus(job.status), errorText, recordID]);
}

function resolveTrackedJob(ctx, record, job) {
  settleOutput(ctx, record.action, record.record_id, job, record.job_id);
  const logs = ctx.shell.logs(record.job_id).slice(-80);
  noteEnvOutcome(ctx, record, job, logs);
  closeTask(ctx, record.job_id, outputStatus(job.status), job.error || "");
  return { id: record.job_id, action: record.action, recordID: record.record_id, startedAt: record.started_at, status: job.status, error: job.error || "", logs };
}

function trackedJob(ctx) {
  ensureSchema(ctx);
  const rows = ctx.sqlite.query("select job_id, action, record_id, started_at from audio_jobs where resolved_at = '' order by started_at desc limit 1");
  if (!rows.length) return null;
  const record = rows[0];
  if (!record.job_id || !ACTIONS.has(record.action)) {
    ctx.sqlite.execute("update audio_jobs set resolved_at = ? where job_id = ?", [new Date().toISOString(), record.job_id]);
    return null;
  }
  let job;
  try { job = ctx.shell.status(record.job_id); }
  catch (error) {
    const message = error instanceof Error ? error.message : "shell job is unavailable";
    const interrupted = { status: "interrupted", error: tr(ctx, `任务记录不可恢复：${message}`, `Task record cannot be recovered: ${message}`) };
    settleOutput(ctx, record.action, record.record_id, interrupted, record.job_id);
    noteEnvOutcome(ctx, record, interrupted, []);
    closeTask(ctx, record.job_id, "interrupted", interrupted.error);
    return { id: record.job_id, action: record.action, recordID: record.record_id, startedAt: record.started_at, status: interrupted.status, error: interrupted.error, logs: [] };
  }
  const status = shellJobStatus(job);
  if (!isActiveJob(status) && !isTerminalJob(status)) {
    const interrupted = { status: "interrupted", error: tr(ctx, `任务状态不可识别：${status || "empty"}`, `Task status unrecognized: ${status || "empty"}`) };
    settleOutput(ctx, record.action, record.record_id, interrupted, record.job_id);
    noteEnvOutcome(ctx, record, interrupted, []);
    closeTask(ctx, record.job_id, "interrupted", interrupted.error);
    return { id: record.job_id, action: record.action, recordID: record.record_id, startedAt: record.started_at, status: interrupted.status, error: interrupted.error, logs: [] };
  }
  return resolveTrackedJob(ctx, record, { status, error: shellJobError(job) });
}

function ensureNoActiveJob(ctx) {
  ensureSchema(ctx);
  const existing = trackedJob(ctx);
  if (existing && isActiveJob(existing.status)) throw new Error(tr(ctx, "声音工坊已有任务正在执行，请等待完成或先取消。", "Audio Studio already has a task running; wait for it to finish or cancel it first."));
  if (existing) ctx.sqlite.execute("update audio_jobs set resolved_at = ? where job_id = ?", [new Date().toISOString(), existing.id]);
}

function trackJob(ctx, job, action, recordID = "", opts = {}) {
  ensureSchema(ctx);
  const shellID = shellJobID(job);
  if (!shellID || !ACTIONS.has(action)) throw new Error("Audio task did not return a valid shell job id.");
  const id = opts.taskId || outputID();
  const now = new Date().toISOString();
  const source = opts.source === "ai" ? "ai" : "manual";
  const submittedBy = value(opts, "submittedBy");
  let meta = "{}";
  try { meta = JSON.stringify(opts.meta || {}); } catch (_) { meta = "{}"; }
  const logPath = taskLogPath(id);
  // 关闭上一条仍在途的任务，保证「单在途」语义（与 audio_jobs 一致）。
  ctx.sqlite.execute("update audio_jobs set resolved_at = ? where resolved_at = ''", [now]);
  ctx.sqlite.execute("insert into audio_jobs (job_id, action, record_id, started_at, resolved_at) values (?, ?, ?, ?, '')", [shellID, action, recordID, now]);
  ctx.sqlite.execute("update audio_tasks set resolved_at = ? where resolved_at = '' and state in ('queued','running')", [now]);
  ctx.sqlite.execute("insert into audio_tasks (id, shell_job_id, action, record_id, source, submitted_by, state, progress, meta_json, log_path, error, created_at, started_at, resolved_at) values (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?, '', ?, ?, '')", [id, shellID, action, recordID, source, submittedBy, meta, logPath, now, now]);
  if (action === "prepare" || action === "install") clearEnvError(ctx);
  return job;
}

function markFailed(ctx, action, recordID, error) {
  const table = RECORD_TABLES[action];
  if (!table || !recordID) return;
  ctx.sqlite.execute(`update ${table} set status = 'failed', error = ? where id = ?`, [error instanceof Error ? error.message : String(error), recordID]);
}

function meaningfulError(ctx, logs, fallback) {
  const lines = (logs || []).map((entry) => String(entry.text || "")).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || fallback || tr(ctx, "未知错误", "Unknown error");
}

function envErrorRow(ctx) {
  ensureSchema(ctx);
  const rows = ctx.sqlite.query("select job_id, action, error, logs, updated_at from audio_env_error where id = 1");
  return rows.length ? rows[0] : null;
}

function storeEnvError(ctx, action, jobID, error, logs) {
  ctx.sqlite.execute("insert into audio_env_error (id, job_id, action, error, logs, updated_at) values (1, ?, ?, ?, ?, ?) on conflict(id) do update set job_id = excluded.job_id, action = excluded.action, error = excluded.error, logs = excluded.logs, updated_at = excluded.updated_at", [jobID || "", action, error, JSON.stringify(logs), new Date().toISOString()]);
}

function clearEnvError(ctx) {
  ctx.sqlite.execute("delete from audio_env_error where id = 1");
}

// Persist prepare/install outcomes so the real error and its log tail remain
// visible in audio.status even after the shell job is resolved (the platform
// only records a generic "exit status 1" on the job itself).
function noteEnvOutcome(ctx, record, job, logs = []) {
  if (record.action !== "prepare" && record.action !== "install") return;
  if (!isTerminalJob(job.status)) return;
  if (job.status === "completed") { clearEnvError(ctx); return; }
  const tail = (logs || []).slice(-40);
  storeEnvError(ctx, record.action, record.job_id, meaningfulError(ctx, tail, job.error), tail);
}

function activeTaskOf(ctx, shellJobId) {
  if (!shellJobId) return null;
  const rows = ctx.sqlite.query("select id, action, record_id, source, submitted_by, state, progress, meta_json, log_path, error, created_at from audio_tasks where shell_job_id = ? and resolved_at = '' order by created_at desc limit 1", [shellJobId]);
  if (!rows.length) return null;
  const row = rows[0];
  let meta = {};
  try { meta = JSON.parse(row.meta_json || "{}"); } catch (_) { /* keep empty */ }
  return { id: row.id, action: row.action, name: taskName(row.action, meta), recordId: row.record_id, source: row.source, submittedBy: row.submittedBy, state: row.state, progress: row.progress, createdAt: row.createdAt, meta, logPath: row.log_path };
}

function status(_, ctx) {
  const activeJob = trackedJob(ctx);
  const activeTask = activeTaskOf(ctx, activeJob && isActiveJob(activeJob.status) ? activeJob.id : null);
  const environment = ctx.python.status();
  const envError = envErrorRow(ctx);
  let envFailure = null;
  if (envError && envError.error) {
    let storedLogs = [];
    try { storedLogs = JSON.parse(envError.logs || "[]"); } catch (_) { /* keep empty */ }
    envFailure = { setupError: envError.error, setupLogs: storedLogs };
  }
  if (!environment.ready) {
    return {
      ready: false, pending: true, modelsRoot: "~/.recut/models/audio-studio",
      error: envFailure ? tr(ctx, `运行环境准备失败：${envFailure.setupError}`, `Runtime setup failed: ${envFailure.setupError}`) : environment.error || tr(ctx, "Python 运行环境尚未就绪。", "The Python runtime is not ready yet."),
      asr: { installed: [] }, tts: { ready: false }, downloadSource: downloadSource(ctx), activeJob, activeTask,
      ...(envFailure || {}),
    };
  }
  const runner = run(ctx, ["status"], 20);
  // 保证 asr/tts 契约稳定：即便 runner status 载荷缺字段，也给 UI 兜底为空对象/空数组。
  const result = { ...runner, asr: runner.asr || { installed: [] }, tts: runner.tts || { ready: false }, downloadSource: downloadSource(ctx), activeJob, activeTask };
  if (!runner.ready) {
    result.ready = false;
    if (envFailure) {
      result.setupError = envFailure.setupError;
      result.setupLogs = envFailure.setupLogs;
      result.error = tr(ctx, `运行环境准备失败：${envFailure.setupError}`, `Runtime setup failed: ${envFailure.setupError}`);
    } else {
      result.setupError = runner.error || tr(ctx, "运行环境检查未通过。", "The runtime check failed.");
      result.setupLogs = [];
    }
  }
  return result;
}

function prepare(_, ctx) {
  ensureNoActiveJob(ctx);
  const tid = outputID();
  const job = trackJob(ctx, ctx.python.prepare(), "prepare", "", { taskId: tid, meta: { type: "运行环境" } });
  return { job, taskId: tid };
}

function install(input, ctx) {
  const selected = value(input, "model");
  const dlSource = value(input, "source") || downloadSource(ctx);
  if (!ASR_MODELS.has(selected) && selected !== "cosyvoice2" && !VOXCPM_MODELS.includes(selected)) throw new Error("model must be an ASR model, cosyvoice2 or a VoxCPM version");
  setDownloadSource(ctx, dlSource);
  ensureNoActiveJob(ctx);
  const tid = outputID();
  const logPath = taskLogPath(tid);
  const job = ctx.python.run(["python/audio_runner.py", "install", "--model", selected, "--source", dlSource, "--task-log", logPath]);
  const meta = { type: ASR_MODELS.has(selected) ? "ASR 模型" : "TTS 模型", model: selected };
  trackJob(ctx, job, "install", "", { taskId: tid, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), meta });
  return { job, taskId: tid };
}

function transcribe(input, ctx) {
  ensureSchema(ctx);
  const assetID = value(input, "assetId");
  const kind = value(input, "kind");
  const model = value(input, "model");
  const language = value(input, "language");
  const saveToLibrary = input.saveToLibrary === true || String(input.saveToLibrary || "").trim().toLowerCase() === "true";
  if (!assetID || !KINDS.has(kind) || !ASR_MODELS.has(model) || !LANGUAGES.has(language)) throw new Error("assetId, kind, model and language are required");
  ensureNoActiveJob(ctx);
  // saveToLibrary 幂等去重：同源+同模型+同语言且已入库的已完成转写直接复用，不重复起 job、不产生重复全局资产。
  if (saveToLibrary) {
    const reuse = ctx.sqlite.query("select id, saved_asset_id from audio_transcripts where status = 'completed' and save_to_library = 1 and saved_asset_id != '' and source_asset_id = ? and model = ? and language = ? order by created_at desc limit 1", [assetID, model, language]);
    if (reuse.length) return { reused: true, transcript: { id: reuse[0].id }, transcriptAssetId: reuse[0].saved_asset_id };
  }
  const source = ctx.media.materialize(assetID);
  if (source.kind !== kind) throw new Error(`Selected Asset is ${source.kind}, not ${kind}.`);
  const id = outputID();
  const stem = `transcripts/${id}`;
  const record = { id, sourceAssetId: assetID, sourceKind: kind, model, language, saveToLibrary, srtPath: `${stem}.srt`, jsonPath: `${stem}.json`, audioPath: `${stem}.audio.wav`, savedAssetId: "", duration: 0, createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_transcripts (id, source_asset_id, source_kind, model, language, save_to_library, srt_path, json_path, audio_path, saved_asset_id, duration, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.sourceAssetId, record.sourceKind, record.model, record.language, record.saveToLibrary ? 1 : 0, record.srtPath, record.jsonPath, record.audioPath, record.savedAssetId, record.duration, record.createdAt, record.jobId, record.status, record.error]);
  const tid = outputID();
  const logPath = taskLogPath(tid);
  try {
    const job = ctx.python.run(["python/audio_runner.py", "transcribe", "--model", model, "--language", language, "--input", source.path, "--output", stem, "--task-log", logPath]);
    const tracked = trackJob(ctx, job, "transcribe", id, { taskId: tid, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), meta: { type: "转写", model, language, sourceAssetId: assetID, sourceKind: kind } });
    record.jobId = shellJobID(tracked);
    ctx.sqlite.execute("update audio_transcripts set job_id = ? where id = ?", [record.jobId, id]);
    return { job: tracked, taskId: tid, transcript: { id } };
  } catch (error) {
    markFailed(ctx, "transcribe", id, error);
    throw error;
  }
}

// saveToLibrary 懒终态：记录已完成且要求入库但还没入库时，幂等补一次 importTranscript。
// 编辑器侧 subtitle.status 轮询 audio.transcript 时自然触发，无需常驻 watcher。
function finalizeSaveToLibrary(ctx, row) {
  if (row.save_to_library !== 1 && String(row.save_to_library || "").trim() !== "1" && String(row.save_to_library || "").trim().toLowerCase() !== "true") return row.saved_asset_id || "";
  if (row.saved_asset_id) return row.saved_asset_id;
  if (row.status !== "completed") return "";
  if (!row.audio_path) throw new Error(tr(ctx, "该转写没有保留源声音轨，无法保存为转写素材，请重新转写。", "This transcript has no source audio track, so it can't be saved as a transcript asset. Please transcribe again."));
  const asset = ctx.media.importTranscript({
    name: `transcript-${row.id}.wav`,
    sourceAssetId: row.source_asset_id,
    audioPath: row.audio_path,
    srtPath: row.srt_path,
    jsonPath: row.json_path,
    mimeType: "audio/wav",
    model: row.model,
    language: row.language,
    duration: row.duration,
  });
  ctx.sqlite.execute("update audio_transcripts set saved_asset_id = ? where id = ?", [asset.id, row.id]);
  return asset.id;
}

function readJSON(ctx, path) {
  try { return JSON.parse(ctx.files.readText(path)); }
  catch (_) { return null; }
}

function transcriptRecord(ctx, row) {
  const record = { id: row.id, sourceAssetId: row.source_asset_id, sourceKind: row.source_kind, model: row.model, language: row.language, duration: row.duration, createdAt: row.created_at, savedAssetId: row.saved_asset_id || "", srtURL: "", jsonURL: "", audioURL: "" };
  try {
    record.srtURL = ctx.files.url(row.srt_path);
    record.jsonURL = ctx.files.url(row.json_path);
    if (row.audio_path) record.audioURL = ctx.files.url(row.audio_path);
  } catch (error) {
    ctx.sqlite.execute("update audio_transcripts set status = 'failed', error = ? where id = ?", [error instanceof Error ? error.message : tr(ctx, "转写文件已丢失。", "Transcript files are missing."), row.id]);
    return null;
  }
  return record;
}

function transcripts(_, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  const rows = ctx.sqlite.query("select id, source_asset_id, source_kind, model, language, save_to_library, duration, created_at, srt_path, json_path, audio_path, saved_asset_id, status from audio_transcripts where status = 'completed' order by created_at desc");
  return rows.map((row) => {
    try { finalizeSaveToLibrary(ctx, row); } catch (_) { /* 入库失败不阻断列表，保留私有产物 */ }
    return transcriptRecord(ctx, row);
  }).filter(Boolean);
}

function transcript(input, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id, source_asset_id, source_kind, model, language, save_to_library, duration, created_at, srt_path, json_path, audio_path, saved_asset_id, status, error from audio_transcripts where id = ?", [id]);
  if (!rows.length) throw new Error("Audio transcript was not found.");
  const row = rows[0];
  if (row.status !== "completed") {
    // 旧记录可能有平台笼统的 "exit status 1"：借 job 日志尾巴补一次可读错误。
    let errorText = String(row.error || "");
    if (row.status === "failed" && row.job_id && errorText) {
      try {
        const meaningful = meaningfulError(ctx, ctx.shell.logs(row.job_id).slice(-80), errorText);
        if (meaningful && meaningful !== errorText) {
          ctx.sqlite.execute("update audio_transcripts set error = ? where id = ?", [meaningful, id]);
          errorText = meaningful;
        }
      } catch (_) { /* 日志不可读时保留原错误 */ }
    }
    return { id: row.id, status: row.status, error: errorText };
  }
  let savedAssetId = row.saved_asset_id || "";
  if (String(row.save_to_library || "").trim() === "1" || row.save_to_library === 1) {
    savedAssetId = finalizeSaveToLibrary(ctx, row) || savedAssetId;
  }
  const record = transcriptRecord(ctx, row);
  if (!record) throw new Error("Audio transcript files are missing.");
  record.savedAssetId = savedAssetId;
  const data = readJSON(ctx, row.json_path) || { segments: [] };
  return { ...record, status: row.status, segments: data.segments || [], srt: ctx.files.readText(row.srt_path), transcriptAssetId: savedAssetId };
}

function characterCreate(input, ctx) {
  ensureSchema(ctx);
  const assetID = value(input, "assetId");
  const name = value(input, "name");
  const model = value(input, "model");
  if (!assetID || !name || !ASR_MODELS.has(model)) throw new Error("assetId, name and model are required");
  ensureNoActiveJob(ctx);
  const source = ctx.media.materialize(assetID);
  if (source.kind !== "audio") throw new Error(`Selected Asset is ${source.kind}, not audio.`);
  const id = outputID();
  const stem = `characters/${id}/sample`;
  const record = { id, name, model, samplePath: `${stem}.wav`, sampleAssetId: "", promptText: "", createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_characters (id, name, model, sample_path, sample_asset_id, prompt_text, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.name, record.model, record.samplePath, record.sampleAssetId, record.promptText, record.createdAt, record.jobId, record.status, record.error]);
  const tid = outputID();
  const logPath = taskLogPath(tid);
  try {
    const job = ctx.python.run(["python/audio_runner.py", "character", "--model", model, "--input", source.path, "--output", stem, "--task-log", logPath]);
    const tracked = trackJob(ctx, job, "character", id, { taskId: tid, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), meta: { type: "声音角色", model, characterName: name, sourceAssetId: assetID } });
    record.jobId = shellJobID(tracked);
    ctx.sqlite.execute("update audio_characters set job_id = ? where id = ?", [record.jobId, id]);
    return { job: tracked, taskId: tid, character: { id } };
  } catch (error) {
    markFailed(ctx, "character", id, error);
    throw error;
  }
}

function characterRecord(ctx, row) {
  const record = { id: row.id, name: row.name, model: row.model, promptText: row.prompt_text, sampleAssetId: row.sample_asset_id, createdAt: row.created_at, sampleURL: "" };
  try { record.sampleURL = ctx.files.url(row.sample_path); }
  catch (error) {
    ctx.sqlite.execute("update audio_characters set status = 'failed', error = ? where id = ?", [error instanceof Error ? error.message : tr(ctx, "角色参考音已丢失。", "The character reference audio is missing."), row.id]);
    return null;
  }
  return record;
}

function characterQuality(ctx, row) {
  const meta = readJSON(ctx, `${row.sample_path}.meta.json`);
  return meta?.quality?.passed === true && Number(meta?.speaker?.dimensions) > 0 && Number(meta?.calibration?.fidelity) >= 0.85 ? meta : null;
}

function characterComplete(input, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id, name, model, sample_path, sample_asset_id, prompt_text, created_at, status, error from audio_characters where id = ?", [id]);
  if (!rows.length) throw new Error("Audio character was not found.");
  const row = rows[0];
  if (row.status === "queued" || row.status === "") return { id: row.id, status: "queued" };
  const meta = readJSON(ctx, `${row.sample_path}.meta.json`);
  if (row.status === "completed" && meta && meta.promptText && meta.quality?.passed === true && Number(meta.speaker?.dimensions) > 0 && Number(meta.calibration?.fidelity) >= 0.85) {
    ctx.sqlite.execute("update audio_characters set prompt_text = ? where id = ?", [meta.promptText, id]);
    row.prompt_text = meta.promptText;
  }
  if (row.status === "completed" && !characterQuality(ctx, row)) {
    const qualityError = tr(ctx, "声音角色未通过参考音、声纹或朗读回读验收，请重新创建。", "The voice character did not pass the reference, voiceprint or read-back verification. Please create it again.");
    ctx.sqlite.execute("update audio_characters set status = 'failed', error = ? where id = ?", [qualityError, id]);
    return { id: row.id, status: "failed", error: qualityError };
  }
  const record = characterRecord(ctx, row);
  if (!record) throw new Error("Audio character sample is missing.");
  return { ...record, status: row.status, error: row.error || "" };
}

function characters(_, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  return ctx.sqlite.query("select id, name, model, sample_path, sample_asset_id, prompt_text, created_at from audio_characters where status = 'completed' order by created_at desc").filter((row) => characterQuality(ctx, row)).map((row) => characterRecord(ctx, row)).filter(Boolean);
}

function characterRemove(input, ctx) {
  ensureSchema(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id from audio_characters where id = ?", [id]);
  if (!rows.length) throw new Error("Audio character was not found.");
  ctx.sqlite.execute("delete from audio_characters where id = ?", [id]);
  ctx.sqlite.execute("update audio_syntheses set status = 'failed', error = ? where character_id = ? and status = 'queued'", [tr(ctx, "声音角色已删除。", "The voice character was removed."), id]);
  return { id, removed: true };
}

function synthesize(input, ctx) {
  ensureSchema(ctx);
  const characterID = value(input, "characterId");
  const text = value(input, "text");
  const style = value(input, "style") || "neutral";
  const engine = value(input, "engine") || "cosyvoice2";
  if (!text) throw new Error("text is required");
  if (!ENGINES.has(engine)) throw new Error("engine must be cosyvoice2, voxcpm2, voxcpm1.5 or voxcpm-0.5b");
  if (!STYLES.has(style)) throw new Error("style must be neutral, calm, excited, or gentle");
  const isVoxCpm = VOXCPM_MODELS.includes(engine);
  if (isVoxCpm && !characterID && engine !== "voxcpm2") throw new Error("VoxCPM1.5 / VoxCPM-0.5B use continuation cloning and need a voice character.");
  ensureNoActiveJob(ctx);
  const characters = characterID ? ctx.sqlite.query("select id, sample_path, prompt_text from audio_characters where id = ? and status = 'completed'", [characterID]).filter((row) => characterQuality(ctx, row)) : [];
  if (characterID && !characters.length) throw new Error("Selected voice character was not found.");
  const character = characters[0] || { id: "__cosyvoice_default__", sample_path: "", prompt_text: "" };
  const id = outputID();
  const outputPath = `syntheses/${id}.wav`;
  const record = { id, characterId: characterID, text, style, engine, outputPath, mimeType: "audio/wav", savedAssetId: "", createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_syntheses (id, character_id, text, style, engine, output_path, mime_type, saved_asset_id, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.characterId, record.text, record.style, record.engine, record.outputPath, record.mimeType, record.savedAssetId, record.createdAt, record.jobId, record.status, record.error]);
  const tid = outputID();
  const logPath = taskLogPath(tid);
  try {
    const args = ["python/audio_runner.py", "synthesize", "--text", text, "--style", style, "--engine", engine, "--output", outputPath, "--task-log", logPath];
    if (characterID) args.push("--reference", character.sample_path, "--prompt-text", character.prompt_text);
    else args.push("--default-voice");
    const job = ctx.python.run(args);
    const tracked = trackJob(ctx, job, "synthesize", id, { taskId: tid, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), meta: { type: "配音合成", engine, characterId: characterID, characterName: character.name } });
    record.jobId = shellJobID(tracked);
    ctx.sqlite.execute("update audio_syntheses set job_id = ? where id = ?", [record.jobId, id]);
    return { job: tracked, taskId: tid, synthesis: { id } };
  } catch (error) {
    markFailed(ctx, "synthesize", id, error);
    throw error;
  }
}

function synthesisRecord(ctx, row) {
  const record = { id: row.id, characterId: row.character_id, text: row.text, style: row.style, engine: row.engine || "cosyvoice2", savedAssetId: row.saved_asset_id, createdAt: row.created_at, outputURL: "", duration: 0 };
  try { record.outputURL = ctx.files.url(row.output_path); }
  catch (error) {
    ctx.sqlite.execute("update audio_syntheses set status = 'failed', error = ? where id = ?", [error instanceof Error ? error.message : tr(ctx, "合成音频已丢失。", "The synthesized audio is missing."), row.id]);
    return null;
  }
  const meta = readJSON(ctx, `${row.output_path}.meta.json`);
  if (meta && meta.duration) record.duration = meta.duration;
  return record;
}

function synthesisComplete(input, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id, character_id, text, style, engine, output_path, saved_asset_id, created_at, status, error from audio_syntheses where id = ?", [id]);
  if (!rows.length) throw new Error("Audio synthesis was not found.");
  const row = rows[0];
  if (row.status === "queued" || row.status === "") return { id: row.id, status: "queued" };
  const record = synthesisRecord(ctx, row);
  if (!record) throw new Error("Audio synthesis output is missing.");
  return { ...record, status: row.status, error: row.error || "" };
}

function syntheses(_, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  return ctx.sqlite.query("select id, character_id, text, style, engine, output_path, saved_asset_id, created_at from audio_syntheses where status = 'completed' order by created_at desc").map((row) => synthesisRecord(ctx, row)).filter(Boolean);
}

function save(input, ctx) {
  ensureSchema(ctx);
  const id = value(input, "id");
  const kind = value(input, "kind");
  if (kind === "transcript") {
    const rows = ctx.sqlite.query("select id, source_asset_id, srt_path, json_path, audio_path, model, language, duration, saved_asset_id from audio_transcripts where id = ? and status = 'completed'", [id]);
    if (!rows.length) throw new Error("Audio transcript was not found.");
    const record = rows[0];
    if (!record.audio_path) throw new Error(tr(ctx, "该转写没有保留源声音轨，无法保存为转写素材，请重新转写。", "This transcript has no source audio track, so it can't be saved as a transcript asset. Please transcribe again."));
    if (!record.saved_asset_id) {
      const asset = ctx.media.importTranscript({
        name: `transcript-${record.id}.wav`,
        sourceAssetId: record.source_asset_id,
        audioPath: record.audio_path,
        srtPath: record.srt_path,
        jsonPath: record.json_path,
        mimeType: "audio/wav",
        model: record.model,
        language: record.language,
        duration: record.duration,
      });
      ctx.sqlite.execute("update audio_transcripts set saved_asset_id = ? where id = ?", [asset.id, id]);
      record.saved_asset_id = asset.id;
    }
    return { id, kind, assetId: record.saved_asset_id };
  }
  if (kind === "synthesis") {
    const rows = ctx.sqlite.query("select id, output_path, mime_type, saved_asset_id from audio_syntheses where id = ? and status = 'completed'", [id]);
    if (!rows.length) throw new Error("Audio synthesis was not found.");
    const record = rows[0];
    if (!record.saved_asset_id) {
      const asset = ctx.media.importFile({ path: record.output_path, name: `voice-${record.id}.wav`, mimeType: record.mime_type });
      ctx.sqlite.execute("update audio_syntheses set saved_asset_id = ? where id = ?", [asset.id, id]);
      record.saved_asset_id = asset.id;
    }
    return { id, kind, assetId: record.saved_asset_id };
  }
  if (kind === "character") {
    const rows = ctx.sqlite.query("select id, sample_path, sample_asset_id from audio_characters where id = ? and status = 'completed'", [id]);
    if (!rows.length) throw new Error("Audio character was not found.");
    const record = rows[0];
    if (!record.sample_asset_id) {
      const asset = ctx.media.importFile({ path: record.sample_path, name: `voice-character-${record.id}.wav`, mimeType: "audio/wav" });
      ctx.sqlite.execute("update audio_characters set sample_asset_id = ? where id = ?", [asset.id, id]);
      record.sample_asset_id = asset.id;
    }
    return { id, kind, assetId: record.sample_asset_id };
  }
  throw new Error("kind must be transcript, synthesis or character");
}

function job(_, ctx) {
  return trackedJob(ctx);
}

function resolveJob(input, ctx) {
  ensureSchema(ctx);
  const id = value(input, "id");
  const active = trackedJob(ctx);
  if (!active || active.id !== id) return { id, resolved: false };
  if (isActiveJob(active.status)) throw new Error("Audio task is still running.");
  ctx.sqlite.execute("update audio_jobs set resolved_at = ? where job_id = ?", [new Date().toISOString(), id]);
  return { id, resolved: true };
}

function cancel(_, ctx) {
  const active = trackedJob(ctx);
  if (!active || !isActiveJob(active.status)) return { cancelled: false };
  ctx.shell.cancel(active.id);
  return { cancelled: true, id: active.id };
}

function tasksList(input, ctx) { return listTasks(ctx, input || {}); }

function taskGet(input, ctx) { return getTask(ctx, input); }

function taskLogs(input, ctx) { return readTaskLogs(ctx, input); }

function taskCancel(input, ctx) {
  ensureSchema(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select shell_job_id, state from audio_tasks where id = ?", [id]);
  if (!rows.length) return { cancelled: false };
  if (!isActiveJob(rows[0].state)) return { cancelled: false };
  ctx.shell.cancel(rows[0].shell_job_id);
  return { cancelled: true, id };
}

recut.operation.register("audio.status", status);
recut.operation.register("audio.prepare", prepare);
recut.operation.register("audio.install", install);
recut.operation.register("audio.transcribe", transcribe);
recut.operation.register("audio.transcripts", transcripts);
recut.operation.register("audio.transcript", transcript);
recut.operation.register("audio.character.create", characterCreate);
recut.operation.register("audio.character.complete", characterComplete);
recut.operation.register("audio.characters", characters);
recut.operation.register("audio.character.remove", characterRemove);
recut.operation.register("audio.synthesize", synthesize);
recut.operation.register("audio.synthesis.complete", synthesisComplete);
recut.operation.register("audio.syntheses", syntheses);
recut.operation.register("audio.save", save);
recut.operation.register("audio.job", job);
recut.operation.register("audio.resolve", resolveJob);
recut.operation.register("audio.cancel", cancel);
recut.operation.register("audio.tasks.list", tasksList);
recut.operation.register("audio.task.get", taskGet);
recut.operation.register("audio.task.logs", taskLogs);
recut.operation.register("audio.task.cancel", taskCancel);
