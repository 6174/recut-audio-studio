/*
 * [INPUT]: 依赖 ctx.sqlite 保存模型下载源、转写/角色/合成记录与统一任务账本 audio_tasks（含 queued 排队语义与 payload 重放载荷），ctx.media 复制/显式导入素材，ctx.files 生成私有预览 URL，ctx.python 与 ctx.shell 执行可观察本地任务（prepare 全量走 ctx.python.prepare，定向 cosyvoice/voxcpm 走 ctx.python.run 执行 bootstrap.py --target），CDN 声音预设 manifest（经 audio_runner presets 子命令拉取，内置 bootstrap 兜底）
 * [OUTPUT]: 注册环境检查（audio.status，含在途任务清单 tasks）、定向/全量环境准备（audio.prepare target: all|cosyvoice|voxcpm）、下载源设置（audio.settings.set）、Whisper/Qwen 模型安装、转写、通过参考音与声纹验收的声音角色创建、声音预设枚举（audio.presets）、预设参考音按需准备（audio.preset.prepare：缓存查 → CDN 下载 + sha256 校验 → 私有 preview URL，供 UI 免手动下载试听）、VoxCPM2 Voice Design / 预设实例化建角色（audio.character.design，origin=design/preset，saveToLibrary 懒入库并回填 assetId）、配音合成（CosyVoice 或 VoxCPM 引擎/版本可选，支持 presetId 参考音，与 characterId 互斥）、历史与用户确认入库 operation；转写可保存为源声音 + SRT + JSON 的 platform transcript 素材。
 * 任务并发模型（rfc/2026-09-03-task-queue-and-parallelism.md）：推理类（transcribe/character/design/synthesize）单槽 FIFO 排队串行，环境准备（prepare）单槽排队（等推理排空），模型下载（install）不限并行；提交永不拒绝，空槽立即派发、占槽时入队（返回 job=null + taskId）；pumpQueue（settleAllJobs 结算 + 守卫派发）由 status/tasks.list/提交/取消轮询驱动。旧单在途账本 audio_jobs 退役（启动清扫遗留行）。audio.transcribe 扩了 saveToLibrary 开关（默认 false=私有产物不自动入库；true=终态懒入库为全局 transcript 素材并幂等去重，一次能力调用完成转写+入库）。转写/列表/详情/状态 op 已标记 capability，可被其他 App 经 ctx.capabilities.invoke 复用。
 * [POS]: audio-studio 的唯一业务后端；声音角色须通过质量验收（design/preset 产物按回读验收入账，走同一任务中心），未选角色/预设时使用 CosyVoice 官方默认声音进入 TTS，输出先停留在 App 文件沙箱，绝不生成时自动创建素材库 Asset（除 saveToLibrary:true 的显式授权）。
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
const ACTIONS = new Set(["prepare", "install", "transcribe", "character", "design", "synthesize"]);
const PREPARE_TARGETS = new Set(["all", "cosyvoice", "voxcpm"]);
// 并发分类（rfc task-queue D1）：推理类单槽 FIFO 串行（torch 并行加载会 OOM）；
// 环境准备单槽串行（venv 重建不可与在途推理并行）；install 纯磁盘/网络、不限并行。
const INFER_ACTIONS = new Set(["transcribe", "character", "design", "synthesize"]);
// [preset-fallback:generated] 以下块由 python/publish_presets.py --sync 从 presets/catalog.json 再生成，勿手改。
const PRESET_BOOTSTRAP_FALLBACK = [
  {"id": "neutral-female", "name": {"zh": "小雅 · 中性女声", "en": "Xiaoya · Neutral Female"}, "scene": "general"},
  {"id": "jieshuo-xiaoshuai", "name": {"zh": "解说 · 小帅风", "en": "Narrator · Xiaoshuai"}, "scene": "narration"},
  {"id": "qinggan-nv", "name": {"zh": "情感 · 暖阳", "en": "Emotion · Warm Sun"}, "scene": "emotion"},
  {"id": "xuanyi-nan", "name": {"zh": "悬疑 · 低语", "en": "Suspense · Undertone"}, "scene": "suspense"},
  {"id": "tongsheng-nv", "name": {"zh": "童声 · 糖糖", "en": "Kid · Tangtang"}, "scene": "kids"},
  {"id": "daihuo-nv", "name": {"zh": "带货 · 小燃", "en": "Live · Xiaoran"}, "scene": "commerce"},
  {"id": "bobao-nan", "name": {"zh": "播报 · 正声", "en": "Anchor · Zhongsheng"}, "scene": "podcast"},
  {"id": "zhixing-nv", "name": {"zh": "知性 · 静姝", "en": "Insight · Jingshu"}, "scene": "podcast"},
  {"id": "dongbei", "name": {"zh": "东北 · 老铁", "en": "Dongbei · Laotie"}, "scene": "dialect"},
  {"id": "yueyu-nan", "name": {"zh": "粤语 · 阿乐", "en": "Cantonese · Ah Lok"}, "scene": "dialect"},
  {"id": "sichuan-nv", "name": {"zh": "川渝 · 幺妹", "en": "Sichuan · Yaomei"}, "scene": "dialect"},
  {"id": "tuokouxiu-nan", "name": {"zh": "喜剧 · 贫嘴", "en": "Comedy · Pinzui"}, "scene": "narration"},
  {"id": "dashu-wennuan", "name": {"zh": "大叔 · 沉稳", "en": "Uncle · Steady"}, "scene": "podcast"},
  {"id": "boke-nan", "name": {"zh": "播客 · 闲谈", "en": "Podcast · Chat"}, "scene": "podcast"},
  {"id": "shaonv-yuanqi", "name": {"zh": "元气 · 跳跳", "en": "Vlog · Tiaotiao"}, "scene": "general"},
  {"id": "jiaocheng-nv", "name": {"zh": "教程 · 清晰姐", "en": "Tutorial · Qingxi"}, "scene": "general"},
  {"id": "lishi-nan", "name": {"zh": "历史 · 说书人", "en": "History · Storyteller"}, "scene": "narration"},
  {"id": "guanggao-nan", "name": {"zh": "广告 · 磁性嗓", "en": "Ad · Magnetic"}, "scene": "commerce"},
  {"id": "xiaodidi", "name": {"zh": "少年 · 阳阳", "en": "Teen · Yangyang"}, "scene": "kids"},
  {"id": "yeyin-tanci", "name": {"zh": "御姐 · 冷艳", "en": "Belle · Lengyan"}, "scene": "emotion"},
];
// [/preset-fallback:generated]
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

const RECORD_TABLES = {
  transcribe: "audio_transcripts",
  character: "audio_characters",
  design: "audio_characters",
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
  if (action === "design") return `设计声音：${m.characterName || m.presetId || ""}`.trim();
  if (action === "synthesize") return `配音：${m.characterName || (m.presetId ? `预设 ${m.presetId}` : "默认音")}`;
  if (action === "install") return `下载 ${m.model || ""}`.trim();
  if (action === "prepare") return "安装运行环境";
  return action;
}

// 结算单条在途（running）任务行：查平台 shell 状态，终态则产物记录落终态 + 环境错误存档 + 关任务行。
// 多任务并发下的唯一结算路径（旧 trackedJob 只结算最新一条，无法覆盖队列时代的并行任务）。
function settleTaskRow(ctx, row) {
  const closeWith = (state, error) => {
    settleOutput(ctx, row.action, row.record_id, { status: state === "completed" ? "completed" : "failed", error: error || "" }, row.shell_job_id);
    if (row.action === "prepare" || row.action === "install") {
      let logs = [];
      try { logs = ctx.shell.logs(row.shell_job_id).slice(-40); } catch (_) { logs = []; }
      noteEnvOutcome(ctx, { action: row.action, job_id: row.shell_job_id, record_id: row.record_id, started_at: row.created_at }, { status: state, error: error || "" }, logs);
    }
    const finalState = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : state === "interrupted" ? "interrupted" : "failed";
    closeTaskById(ctx, row.id, finalState, error || "");
  };
  let job;
  try { job = ctx.shell.status(row.shell_job_id); }
  catch (error) {
    const message = error instanceof Error ? error.message : "shell job is unavailable";
    closeWith("interrupted", tr(ctx, `任务记录不可恢复：${message}`, `Task record cannot be recovered: ${message}`));
    return { settled: true, status: "interrupted", error: "" };
  }
  const status = shellJobStatus(job);
  if (isActiveJob(status)) return { settled: false, status, error: shellJobError(job) };
  if (!isTerminalJob(status)) {
    closeWith("interrupted", tr(ctx, `任务状态不可恢复：${status || "empty"}`, `Task status cannot be recovered: ${status || "empty"}`));
    return { settled: true, status: "interrupted", error: "" };
  }
  closeWith(status, shellJobError(job));
  return { settled: true, status, error: shellJobError(job) };
}

// 结算全部在途任务行（queued 行无 shell job，跳过；running 无 job 的崩溃残留直接落 failed）。
function settleAllJobs(ctx) {
  ensureSchema(ctx);
  const rows = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, created_at from audio_tasks where state in ('queued','running')");
  for (const row of rows) {
    if (row.state !== "running") continue;
    if (!row.shell_job_id) {
      const message = tr(ctx, "任务未能成功启动。", "The task did not start successfully.");
      ctx.sqlite.execute("update audio_tasks set state = 'failed', error = ?, resolved_at = ? where id = ? and state = 'running' and shell_job_id = ''", [message, new Date().toISOString(), row.id]);
      markFailed(ctx, row.action, row.record_id, message);
      continue;
    }
    void settleTaskRow(ctx, row);
  }
}

function parseTaskMeta(row) {
  try { return JSON.parse(row.meta_json || "{}"); } catch (_) { return {}; }
}

// 推理任务派发前必须完成下载的模型依赖集（D1：权重下载未完成就起推理必然加载坏文件 → 排队等待）。
// transcribe/character 依赖 ASR 回读模型；design 固定走 VoxCPM2；synthesize 依赖所选引擎权重。
function inferModelDeps(meta) {
  const deps = new Set();
  if (meta.model && ASR_MODELS.has(meta.model)) deps.add(meta.model);
  if (meta.engine && ENGINES.has(meta.engine)) deps.add(meta.engine);
  if (meta.origin === "design") deps.add("voxcpm2");
  return [...deps].filter(Boolean);
}

// 由 action + 产物记录 + payload（提交时解析后的输入）重建执行参数；与提交时完全一致。
function buildJobSpec(ctx, action, row, payload) {
  const p = payload || {};
  const logPath = row.log_path || taskLogPath(row.id);
  if (action === "transcribe") {
    return { args: ["python/audio_runner.py", "transcribe", "--model", p.model, "--language", p.language, "--input", p.sourcePath, "--output", `transcripts/${row.record_id}`, "--task-log", logPath] };
  }
  if (action === "character") {
    return { args: ["python/audio_runner.py", "character", "--model", p.model, "--input", p.sourcePath, "--output", `characters/${row.record_id}/sample`, "--task-log", logPath] };
  }
  if (action === "design") {
    const args = ["python/audio_runner.py", "design-character", "--name", p.name, "--model", p.model, "--output-relative", `characters/${row.record_id}/sample`, "--task-log", logPath];
    if (p.presetId) args.push("--preset-id", p.presetId);
    else args.push("--design-desc", p.designDesc);
    return { args };
  }
  if (action === "synthesize") {
    const args = ["python/audio_runner.py", "synthesize", "--text", p.text, "--style", p.style, "--engine", p.engine, "--output", `syntheses/${row.record_id}.wav`, "--task-log", logPath];
    if (p.characterId) {
      const character = ctx.sqlite.query("select id, sample_path, prompt_text from audio_characters where id = ? and status = 'completed'", [p.characterId])[0];
      if (!character) throw new Error(tr(ctx, "声音角色已不存在（可能在排队期间被删除）。", "The voice character no longer exists (it may have been removed)."));
      args.push("--reference", character.sample_path, "--prompt-text", character.prompt_text);
    } else if (p.presetId) args.push("--preset-id", p.presetId);
    else args.push("--default-voice");
    return { args };
  }
  if (action === "prepare") {
    const target = p.target || "all";
    if (target === "all") return { platformPrepare: true };
    return { args: ["python/bootstrap.py", "--target", target, "--task-log", logPath] };
  }
  throw new Error(`Unsupported queue task action: ${action}`);
}

// 派发一条已认领的任务行：条件认领（queued→running）→ 执行 → 回填 shell_job_id；启动失败则行与记录落 failed。
function dispatchTask(ctx, row) {
  const now = new Date().toISOString();
  ctx.sqlite.execute("update audio_tasks set state = 'running', started_at = ? where id = ? and state = 'queued'", [now, row.id]);
  let payload = {};
  try { payload = JSON.parse(row.payload_json || "{}"); } catch (_) { payload = {}; }
  try {
    const spec = buildJobSpec(ctx, row.action, row, payload);
    const job = spec.platformPrepare ? ctx.python.prepare() : ctx.python.run(spec.args);
    const shellID = shellJobID(job);
    if (!shellID) throw new Error(tr(ctx, "平台未返回任务 ID。", "The platform did not return a job id."));
    ctx.sqlite.execute("update audio_tasks set shell_job_id = ? where id = ?", [shellID, row.id]);
    linkRecordJob(ctx, row.action, row.record_id, shellID);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task failed to start.";
    ctx.sqlite.execute("update audio_tasks set state = 'failed', error = ?, resolved_at = ? where id = ?", [message, new Date().toISOString(), row.id]);
    markFailed(ctx, row.action, row.record_id, message);
  }
}

// 队列引擎（D2）：结算全部在途任务 → 按类守卫派发最老排队任务。
// 环境单槽：等推理（含排队）排空；推理单槽：环境任务在跑、或依赖模型仍在下载时不派发。
function pumpQueue(ctx) {
  ensureSchema(ctx);
  settleAllJobs(ctx);
  const actives = ctx.sqlite.query("select action, state, meta_json from audio_tasks where state in ('queued','running')");
  const installing = new Set(actives.filter((row) => row.action === "install" && row.state === "running").map((row) => parseTaskMeta(row).model).filter(Boolean));
  const inferAny = actives.some((row) => INFER_ACTIONS.has(row.action));
  const inferRunning = actives.some((row) => INFER_ACTIONS.has(row.action) && row.state === "running");
  const envRunning = actives.some((row) => row.action === "prepare" && row.state === "running");
  if (!inferAny) {
    const next = ctx.sqlite.query("select id, action, record_id, meta_json, payload_json, log_path from audio_tasks where action = 'prepare' and state = 'queued' order by created_at asc limit 1");
    if (next.length) void dispatchTask(ctx, next[0]);
  }
  if (!inferRunning && !envRunning) {
    const next = ctx.sqlite.query("select id, action, record_id, meta_json, payload_json, log_path from audio_tasks where action in ('transcribe','character','design','synthesize') and state = 'queued' order by created_at asc limit 1");
    if (next.length) {
      const deps = inferModelDeps(parseTaskMeta(next[0]));
      if (!deps.some((model) => installing.has(model))) void dispatchTask(ctx, next[0]);
    }
  }
}

// 任务账本统一提交入口（D2）：只写 audio_tasks 一行；不再强关其他在途任务（排队取代单飞）。
// install 直接 running（无槽位限制）；推理/环境先 queued，由 pumpQueue 按守卫派发。
function submitJob(ctx, { action, recordID = "", payload, meta, source, submittedBy, taskId, started = false }) {
  ensureSchema(ctx);
  const id = taskId || outputID();
  const now = new Date().toISOString();
  const state = started ? "running" : "queued";
  let metaJson = "{}";
  try { metaJson = JSON.stringify(meta || {}); } catch (_) { metaJson = "{}"; }
  let payloadJson = "";
  try { payloadJson = JSON.stringify(payload || {}); } catch (_) { payloadJson = ""; }
  const logPath = taskLogPath(id);
  ctx.sqlite.execute("insert into audio_tasks (id, shell_job_id, action, record_id, source, submitted_by, state, progress, meta_json, payload_json, log_path, error, created_at, started_at, resolved_at) values (?, '', ?, ?, ?, ?, ?, 0, ?, ?, ?, '', ?, ?, ?)", [id, action, recordID, source === "ai" ? "ai" : "manual", submittedBy || "", state, metaJson, payloadJson, logPath, now, started ? now : "", started ? "" : ""]);
  if (action === "prepare" || action === "install") clearEnvError(ctx);
  return id;
}

// 产物记录回填 shell job id（派发成功时；排队期保持空，终态结算不依赖它）。
function linkRecordJob(ctx, action, recordID, shellID) {
  const table = RECORD_TABLES[action];
  if (!table || !recordID || !shellID) return;
  ctx.sqlite.execute(`update ${table} set job_id = ? where id = ?`, [shellID, recordID]);
}

// 按任务行 id 关账（终态）；比 closeTask 的 shell_job_id 匹配更精确（排队行无 job 也能关）。
function closeTaskById(ctx, taskID, state, error) {
  ctx.sqlite.execute("update audio_tasks set state = ?, error = ?, resolved_at = ? where id = ?", [state, error || "", new Date().toISOString(), taskID]);
}

// 取消一条任务：queued 直接落 cancelled（产物记录落 failed「已取消」）；running 走平台 cancel。
function cancelTaskRow(ctx, row) {
  if (row.state === "queued") {
    const error = tr(ctx, "已取消（尚未开始）。", "Cancelled before it started.");
    closeTaskById(ctx, row.id, "cancelled", error);
    const table = RECORD_TABLES[row.action];
    if (table && row.record_id) ctx.sqlite.execute(`update ${table} set status = 'failed', error = ? where id = ?`, [error, row.record_id]);
    return { cancelled: true, id: row.id };
  }
  if (row.state === "running" && row.shell_job_id) {
    try { ctx.shell.cancel(row.shell_job_id); } catch (_) { /* 平台已结算时忽略，下轮结算会落终态 */ }
    return { cancelled: true, id: row.id };
  }
  return { cancelled: false };
}

// 任务中心主列表（audio.tasks.list）：统一账本任务 + 已有产物的历史快照，合并为「任务记录」主面板。
// 历史产物（transcripts/characters/syntheses 的 completed 记录）作为已完成任务并入，
// 让「历史」与「执行日志」全部收敛到任务列表，而不再另设历史面板。
function listTasks(ctx, input = {}) {
  ensureSchema(ctx);
  pumpQueue(ctx); // 结算 + 派发（UI 1.5s 轮询驱动队列推进）
  migrateLegacyTasks(ctx); // 一次性把既有产物并入账本；此后 audio_tasks 是唯一真相源
  const source = value(input, "source");
  const status = value(input, "status");
  const action = value(input, "action");
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);

  const jobs = ctx.sqlite.query("select id, shell_job_id, action, record_id, source, submitted_by, state, progress, meta_json, error, created_at, started_at from audio_tasks").map(toTaskSummary);
  const all = jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const filtered = all.filter((task) => {
    if (source === "ai" || source === "manual") { if (task.source !== source) return false; }
    if (action && ACTIONS.has(action) && task.action !== action) return false;
    if (status === "running") { if (task.state !== "running") return false; }
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
  return { id: task.id, action: task.action, name: taskName(task.action, meta), recordId: task.recordId || task.record_id || "", source: task.source, submittedBy: task.submittedBy || task.submitted_by || "", state: task.state, progress: task.progress, createdAt: task.createdAt || task.created_at, startedAt: task.startedAt || task.started_at || "", jobId: task.jobId || task.shell_job_id || "", error: task.error || "", meta };
}

// 任务中心详情（audio.task.get）。
function getTask(ctx, input) {
  ensureSchema(ctx);
  pumpQueue(ctx); // 结算 + 派发，保证详情读到的是最新状态
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
  pumpQueue(ctx); // 结算 + 派发，保证读取详情时状态与日志同步落到终态
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
  // 声音角色来源（RFC voice-presets D6）：clone(参考音上传) | design(Voice Design) | preset(由预设另存为用户角色)。
  ensureColumn(ctx, "audio_characters", "origin", "text not null default 'clone'");
  // design 产物 saveToLibrary:true 的懒入库标记（终态后幂等导入素材库并回填 assetId）。
  ensureColumn(ctx, "audio_characters", "save_to_library", "integer not null default 0");
  // 排队重放载荷（RFC task-queue D2）：提交时的原始输入，供延迟派发重建执行参数。
  ensureColumn(ctx, "audio_tasks", "payload_json", "text not null default ''");
  // 单在途账本退役（RFC task-queue D2）：旧版本遗留的未决行一次性清扫，新代码以 audio_tasks 为唯一真相源。
  ctx.sqlite.execute("update audio_jobs set resolved_at = ? where resolved_at = ''", [new Date().toISOString()]);
}

function ensureColumn(ctx, table, column, definition) {
  const columns = ctx.sqlite.query(`pragma table_info(${table})`);
  if (columns.some((row) => String(row.name) === column)) return;
  try {
    ctx.sqlite.execute(`alter table ${table} add column ${column} ${definition}`);
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
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

// 「当前在途任务」（audio.status / audio.job）：audio_tasks 最新一条非终态行，合成旧 ActiveAudioJob 形状。
// 只结算、不派发（队列推进由 pumpQueue 的显式调用点驱动）；queued 行 shell_job_id 为空（尚未派发）。
function trackedJob(ctx) {
  settleAllJobs(ctx);
  const rows = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, error, created_at, started_at from audio_tasks where state in ('queued','running') order by created_at desc limit 1");
  if (!rows.length) return null;
  const row = rows[0];
  return { id: row.shell_job_id, action: row.action, recordID: row.record_id, startedAt: row.started_at || row.created_at, status: row.state, error: row.error || "", logs: [] };
}

// 任务行对应的在途 shell job（提交 op 的返回值用）：queued 或无 job → null（即「已排队」）。
function jobForTask(ctx, row) {
  if (!row || row.state === "queued" || !row.shell_job_id) return null;
  const base = { id: row.shell_job_id, action: row.action, recordID: row.record_id, startedAt: row.started_at || row.created_at, logs: [] };
  try {
    const job = ctx.shell.status(row.shell_job_id);
    return { ...base, status: shellJobStatus(job), error: shellJobError(job) };
  } catch (_) {
    return { ...base, status: row.state, error: "" };
  }
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

function status(_, ctx) {
  ensureSchema(ctx);
  pumpQueue(ctx); // 结算 + 派发（UI 轮询驱动队列推进）
  const rows = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, progress, meta_json, error, created_at, started_at from audio_tasks where state in ('queued','running') order by created_at asc");
  const tasks = rows.map(toTaskSummary);
  const latest = rows.length ? toTaskSummary(rows[rows.length - 1]) : null;
  const activeJob = latest ? { id: latest.jobId, action: latest.action, recordID: latest.recordId, startedAt: latest.startedAt || latest.createdAt, status: latest.state, error: latest.error, logs: [] } : null;
  const environment = ctx.python.status();
  const envError = envErrorRow(ctx);
  let envFailure = null;
  if (envError && envError.error) {
    let storedLogs = [];
    try { storedLogs = JSON.parse(envError.logs || "[]"); } catch (_) { storedLogs = []; }
    envFailure = { setupError: envError.error, setupLogs: storedLogs };
  }
  if (!environment.ready) {
    return {
      ready: false, pending: true, modelsRoot: "~/.recut/models/audio-studio",
      error: envFailure ? tr(ctx, `运行环境准备失败：${envFailure.setupError}`, `Runtime setup failed: ${envFailure.setupError}`) : environment.error || tr(ctx, "Python 运行环境尚未就绪。", "The Python runtime is not ready yet."),
      asr: { installed: [] }, tts: { ready: false }, downloadSource: downloadSource(ctx), activeJob, activeTask: latest, tasks,
      ...(envFailure || {}),
    };
  }
  const runner = run(ctx, ["status"], 20);
  // 保证 asr/tts 契约稳定：即便 runner status 载荷缺字段，也给 UI 兜底为空对象/空数组。
  const result = { ...runner, asr: runner.asr || { installed: [] }, tts: runner.tts || { ready: false }, downloadSource: downloadSource(ctx), activeJob, activeTask: latest, tasks };
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

function prepare(input, ctx) {
  const target = value(input, "target") || "all";
  if (!PREPARE_TARGETS.has(target)) throw new Error(tr(ctx, "target 必须是 all、cosyvoice 或 voxcpm。", "target must be all, cosyvoice or voxcpm"));
  // 排队语义（RFC task-queue）：不再拒绝，先结算再入队；环境单槽会在推理排空后由 pumpQueue 自动派发。
  pumpQueue(ctx);
  const tid = outputID();
  submitJob(ctx, { action: "prepare", payload: { target }, meta: { type: tr(ctx, "运行环境", "Runtime environment"), target }, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), taskId: tid });
  pumpQueue(ctx);
  const row = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, started_at, error from audio_tasks where id = ?", [tid])[0];
  return { job: jobForTask(ctx, row), taskId: tid };
}

// audio.settings.set：持久化下载源设置（设置面板变更即写入；audio.install 调用时也会同步写入同一键）。
function settingsSet(input, ctx) {
  ensureSchema(ctx);
  const source = value(input, "downloadSource");
  if (source) setDownloadSource(ctx, source);
  return { downloadSource: downloadSource(ctx) };
}

function install(input, ctx) {
  const selected = value(input, "model");
  const dlSource = value(input, "source") || downloadSource(ctx);
  if (!ASR_MODELS.has(selected) && selected !== "cosyvoice2" && !VOXCPM_MODELS.includes(selected)) throw new Error("model must be an ASR model, cosyvoice2 or a VoxCPM version");
  setDownloadSource(ctx, dlSource);
  // 下载无槽位限制（纯磁盘/网络，RFC task-queue D1）：并行安全，提交即跑，不入队。
  const tid = outputID();
  const logPath = taskLogPath(tid);
  const job = ctx.python.run(["python/audio_runner.py", "install", "--model", selected, "--source", dlSource, "--task-log", logPath]);
  const meta = { type: ASR_MODELS.has(selected) ? "ASR 模型" : "TTS 模型", model: selected };
  submitJob(ctx, { action: "install", payload: { model: selected, source: dlSource }, meta, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), taskId: tid, started: true });
  ctx.sqlite.execute("update audio_tasks set shell_job_id = ? where id = ?", [shellJobID(job), tid]);
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
  pumpQueue(ctx); // 先结算释放槽位；推理单槽被占时提交照收（入队等待，RFC task-queue）
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
  // 排队重放载荷：materialize 后的沙箱路径随 payload 保存（等待期只依赖 App 沙箱副本，不重读素材库）。
  submitJob(ctx, { action: "transcribe", recordID: id, payload: { model, language, sourcePath: source.path }, meta: { type: "转写", model, language, sourceAssetId: assetID, sourceKind: kind }, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), taskId: tid });
  pumpQueue(ctx); // 空槽立即派发；占槽则保持 queued，由后续轮询按 FIFO 自动启动
  const row = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, started_at, error from audio_tasks where id = ?", [tid])[0];
  return { job: jobForTask(ctx, row), taskId: tid, transcript: { id } };
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
  pumpQueue(ctx);
  const source = ctx.media.materialize(assetID);
  if (source.kind !== "audio") throw new Error(`Selected Asset is ${source.kind}, not audio.`);
  const id = outputID();
  const stem = `characters/${id}/sample`;
  const record = { id, name, model, samplePath: `${stem}.wav`, sampleAssetId: "", promptText: "", createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_characters (id, name, model, sample_path, sample_asset_id, prompt_text, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.name, record.model, record.samplePath, record.sampleAssetId, record.promptText, record.createdAt, record.jobId, record.status, record.error]);
  const tid = outputID();
  submitJob(ctx, { action: "character", recordID: id, payload: { model, name, sourcePath: source.path }, meta: { type: "声音角色", model, characterName: name, sourceAssetId: assetID }, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), taskId: tid });
  pumpQueue(ctx);
  const row = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, started_at, error from audio_tasks where id = ?", [tid])[0];
  return { job: jobForTask(ctx, row), taskId: tid, character: { id } };
}

// audio.presets：声音预设清单（CDN manifest 权威源，bootstrap 兜底；只读无副作用，结果不落库）。
// 经 audio_runner 的 presets 子命令拉取（urllib，10s 超时静默回退），Python 环境不可用时回退 JS 内置清单。
function presets(_, ctx) {
  const bootstrapPresets = PRESET_BOOTSTRAP_FALLBACK.map((entry) => ({ ...entry, blurb: {}, designDesc: "", version: "v1", source: "bootstrap", cached: false, cachedBytes: null }));
  try {
    const environment = ctx.python.status();
    if (!environment.ready) return { presets: bootstrapPresets, source: "bootstrap", cdnReachable: false };
    const result = run(ctx, ["presets"], 30);
    if (!result.ready || !Array.isArray(result.presets) || !result.presets.length) throw new Error(result.error || "preset manifest unavailable");
    return { presets: result.presets, version: result.version, source: result.source || "bootstrap", cdnReachable: result.cdnReachable === true };
  } catch (_) {
    return { presets: bootstrapPresets, source: "bootstrap", cdnReachable: false };
  }
}

// audio.preset.prepare：按需把声音预设参考音准备到本地（缓存查 → CDN 下载 + sha256 校验），
// 返回私有 preview URL 供 UI 试听；合成链路本身也走同一 resolve，因此提前准备可复用缓存。
function presetPrepare(input, ctx) {
  const presetId = value(input, "presetId");
  if (!presetId) throw new Error(tr(ctx, "presetId 必填。", "presetId is required."));
  const result = run(ctx, ["preset-prepare", "--preset-id", presetId], 300);
  if (!result.ready) throw new Error(result.error || tr(ctx, "预设参考音准备失败。", "Failed to prepare the preset reference audio."));
  return { presetId, previewURL: ctx.files.url(result.path), bytes: Number(result.bytes) || 0, version: result.version, promptText: result.promptText };
}

// audio.character.design：Voice Design / 预设实例化建角色（RFC voice-presets D3）。
// presetId 分支零推理复制预设参考音；designDesc 分支由 voxcpm2 生成探针并回读验收。
// 产物是 origin="design"/"preset" 的普通角色，与 clone 角色共用 audio.character.complete / audio.save。
function characterDesign(input, ctx) {
  ensureSchema(ctx);
  const name = value(input, "name");
  const designDesc = value(input, "designDesc");
  const presetId = value(input, "presetId");
  const model = value(input, "model") || "qwen3-asr-0.6b";
  const saveToLibrary = input.saveToLibrary === true || String(input.saveToLibrary || "").trim().toLowerCase() === "true";
  if (!name) throw new Error(tr(ctx, "name 必填。", "name is required."));
  if (!designDesc && !presetId) throw new Error(tr(ctx, "designDesc 与 presetId 至少提供一个（二选一）。", "Provide either designDesc or presetId."));
  if (designDesc && presetId) throw new Error(tr(ctx, "designDesc 与 presetId 互斥，请二选一。", "designDesc and presetId are mutually exclusive."));
  if (designDesc && designDesc.length > 120) throw new Error(tr(ctx, "designDesc 不能超过 120 字。", "designDesc must be 120 characters or fewer."));
  if (!ASR_MODELS.has(model)) throw new Error("model must be an ASR model");
  pumpQueue(ctx);
  const id = outputID();
  const stem = `characters/${id}/sample`;
  const origin = presetId ? "preset" : "design";
  const record = { id, name, model, samplePath: `${stem}.wav`, sampleAssetId: "", promptText: "", origin, saveToLibrary, createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_characters (id, name, model, sample_path, sample_asset_id, prompt_text, origin, save_to_library, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.name, record.model, record.samplePath, record.sampleAssetId, record.promptText, record.origin, record.saveToLibrary ? 1 : 0, record.createdAt, record.jobId, record.status, record.error]);
  const tid = outputID();
  const meta = { type: "设计声音", model, characterName: name, origin, ...(presetId ? { presetId } : { designDesc: designDesc.slice(0, 40) }), saveToLibrary };
  submitJob(ctx, { action: "design", recordID: id, payload: { name, model, presetId, designDesc }, meta, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), taskId: tid });
  pumpQueue(ctx);
  const row = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, started_at, error from audio_tasks where id = ?", [tid])[0];
  return { job: jobForTask(ctx, row), taskId: tid, character: { id, origin } };
}

// design/preset 角色的 saveToLibrary 懒终态：完成且要求入库但还没入库时，幂等补一次
// audio.save 的 character 导入路径，并把 assetId 回填进任务 meta（World 链路依赖）。
function finalizeSaveCharacterToLibrary(ctx, row) {
  const flag = row.save_to_library === 1 || String(row.save_to_library || "").trim() === "1" || String(row.save_to_library || "").trim().toLowerCase() === "true";
  if (!flag) return row.sample_asset_id || "";
  if (row.sample_asset_id) return row.sample_asset_id;
  if (row.status !== "completed" || !row.sample_path) return "";
  const asset = ctx.media.importFile({ path: row.sample_path, name: `voice-character-${row.id}.wav`, mimeType: "audio/wav" });
  ctx.sqlite.execute("update audio_characters set sample_asset_id = ? where id = ?", [asset.id, row.id]);
  row.sample_asset_id = asset.id;
  const tasks = ctx.sqlite.query("select id, meta_json from audio_tasks where record_id = ? order by created_at desc limit 1", [row.id]);
  if (tasks.length) {
    let meta = {};
    try { meta = JSON.parse(tasks[0].meta_json || "{}"); } catch (_) { /* keep empty */ }
    meta.characterAssetId = asset.id;
    ctx.sqlite.execute("update audio_tasks set meta_json = ? where id = ?", [JSON.stringify(meta), tasks[0].id]);
  }
  return asset.id;
}

function characterRecord(ctx, row) {
  const record = { id: row.id, name: row.name, model: row.model, promptText: row.prompt_text, sampleAssetId: row.sample_asset_id, origin: row.origin || "clone", createdAt: row.created_at, sampleURL: "" };
  try { record.sampleURL = ctx.files.url(row.sample_path); }
  catch (error) {
    ctx.sqlite.execute("update audio_characters set status = 'failed', error = ? where id = ?", [error instanceof Error ? error.message : tr(ctx, "角色参考音已丢失。", "The character reference audio is missing."), row.id]);
    return null;
  }
  return record;
}

function characterQuality(ctx, row) {
  const meta = readJSON(ctx, `${row.sample_path}.meta.json`);
  // design/preset 产物没有克隆三件套（quality/speaker/calibration）；以回读验收/预设提示词为准。
  const origin = String(row.origin || "clone");
  if (origin === "design" || origin === "preset") return meta && meta.promptText && Number(meta.duration) > 0 ? meta : null;
  return meta?.quality?.passed === true && Number(meta?.speaker?.dimensions) > 0 && Number(meta?.calibration?.fidelity) >= 0.85 ? meta : null;
}

function characterComplete(input, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id, name, model, sample_path, sample_asset_id, prompt_text, origin, save_to_library, created_at, status, error from audio_characters where id = ?", [id]);
  if (!rows.length) throw new Error("Audio character was not found.");
  const row = rows[0];
  if (row.status === "queued" || row.status === "") return { id: row.id, status: "queued" };
  const meta = readJSON(ctx, `${row.sample_path}.meta.json`);
  if (row.status === "completed" && meta && meta.promptText) {
    const origin = String(row.origin || "clone");
    const clonePassed = meta.quality?.passed === true && Number(meta.speaker?.dimensions) > 0 && Number(meta.calibration?.fidelity) >= 0.85;
    if (origin === "design" || origin === "preset" || clonePassed) {
      ctx.sqlite.execute("update audio_characters set prompt_text = ? where id = ?", [meta.promptText, id]);
      row.prompt_text = meta.promptText;
    }
  }
  if (row.status === "completed" && !characterQuality(ctx, row)) {
    const qualityError = tr(ctx, "声音角色未通过参考音、声纹或朗读回读验收，请重新创建。", "The voice character did not pass the reference, voiceprint or read-back verification. Please create it again.");
    ctx.sqlite.execute("update audio_characters set status = 'failed', error = ? where id = ?", [qualityError, id]);
    return { id: row.id, status: "failed", error: qualityError };
  }
  let savedAssetId = row.sample_asset_id || "";
  try { savedAssetId = finalizeSaveCharacterToLibrary(ctx, row) || savedAssetId; } catch (_) { /* 入库失败不阻断读取，可由 audio.save 重试 */ }
  const record = characterRecord(ctx, row);
  if (!record) throw new Error("Audio character sample is missing.");
  return { ...record, status: row.status, error: row.error || "", characterAssetId: savedAssetId };
}

function characters(_, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  return ctx.sqlite.query("select id, name, model, sample_path, sample_asset_id, prompt_text, origin, save_to_library, created_at from audio_characters where status = 'completed' order by created_at desc").filter((row) => characterQuality(ctx, row)).map((row) => {
    try { finalizeSaveCharacterToLibrary(ctx, row); } catch (_) { /* 入库失败不阻断列表，保留私有产物 */ }
    return characterRecord(ctx, row);
  }).filter(Boolean);
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
  const presetId = value(input, "presetId");
  const text = value(input, "text");
  const style = value(input, "style") || "neutral";
  const engine = value(input, "engine") || "cosyvoice2";
  if (!text) throw new Error("text is required");
  if (!ENGINES.has(engine)) throw new Error("engine must be cosyvoice2, voxcpm2, voxcpm1.5 or voxcpm-0.5b");
  if (!STYLES.has(style)) throw new Error("style must be neutral, calm, excited, or gentle");
  if (presetId && characterID) throw new Error(tr(ctx, "presetId 与 characterId 互斥，二者不可同时传入。", "presetId and characterId are mutually exclusive."));
  const isVoxCpm = VOXCPM_MODELS.includes(engine);
  if (isVoxCpm && !characterID && !presetId && engine !== "voxcpm2") throw new Error("VoxCPM1.5 / VoxCPM-0.5B use continuation cloning and need a voice character.");
  pumpQueue(ctx);
  const characters = characterID ? ctx.sqlite.query("select id, name, sample_path, prompt_text from audio_characters where id = ? and status = 'completed'", [characterID]).filter((row) => characterQuality(ctx, row)) : [];
  if (characterID && !characters.length) throw new Error("Selected voice character was not found.");
  const id = outputID();
  const outputPath = `syntheses/${id}.wav`;
  const record = { id, characterId: characterID, text, style, engine, outputPath, mimeType: "audio/wav", savedAssetId: "", createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_syntheses (id, character_id, text, style, engine, output_path, mime_type, saved_asset_id, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.characterId, record.text, record.style, record.engine, record.outputPath, record.mimeType, record.savedAssetId, record.createdAt, record.jobId, record.status, record.error]);
  const tid = outputID();
  // 排队重放载荷为解析后的输入（style/engine 已补默认值）；角色参考音在派发时按 characterId 重读（prompt 以当时为准）。
  submitJob(ctx, { action: "synthesize", recordID: id, payload: { text, style, engine, characterId: characterID, presetId }, meta: { type: "配音合成", engine, characterId: characterID, characterName: characters[0] ? characters[0].name : "", ...(presetId ? { presetId } : {}) }, source: value(input, "origin"), submittedBy: value(input, "submittedBy"), taskId: tid });
  pumpQueue(ctx);
  const row = ctx.sqlite.query("select id, shell_job_id, action, record_id, state, started_at, error from audio_tasks where id = ?", [tid])[0];
  return { job: jobForTask(ctx, row), taskId: tid, synthesis: { id } };
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
  if (!id) return { id, resolved: false };
  const rows = ctx.sqlite.query("select id from audio_tasks where shell_job_id = ?", [id]);
  if (!rows.length) return { id, resolved: false };
  // 队列时代结算统一由 pumpQueue 负责；resolve 仅作「UI 停止跟踪」信号（幂等）。
  return { id, resolved: true };
}

function cancel(_, ctx) {
  pumpQueue(ctx);
  const rows = ctx.sqlite.query("select id, shell_job_id, action, record_id, state from audio_tasks where state in ('queued','running') order by created_at desc limit 1");
  if (!rows.length) return { cancelled: false };
  return cancelTaskRow(ctx, rows[0]);
}

function tasksList(input, ctx) { return listTasks(ctx, input || {}); }

function taskGet(input, ctx) { return getTask(ctx, input); }

function taskLogs(input, ctx) { return readTaskLogs(ctx, input); }

function taskCancel(input, ctx) {
  ensureSchema(ctx);
  pumpQueue(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id, shell_job_id, action, record_id, state from audio_tasks where id = ?", [id]);
  if (!rows.length) return { cancelled: false };
  if (!isActiveJob(rows[0].state)) return { cancelled: false };
  return cancelTaskRow(ctx, rows[0]);
}

recut.operation.register("audio.status", status);
recut.operation.register("audio.prepare", prepare);
recut.operation.register("audio.settings.set", settingsSet);
recut.operation.register("audio.install", install);
recut.operation.register("audio.transcribe", transcribe);
recut.operation.register("audio.transcripts", transcripts);
recut.operation.register("audio.transcript", transcript);
recut.operation.register("audio.character.create", characterCreate);
recut.operation.register("audio.presets", presets);
recut.operation.register("audio.preset.prepare", presetPrepare);
recut.operation.register("audio.character.design", characterDesign);
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
