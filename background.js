/*
 * [INPUT]: 依赖 ctx.sqlite 保存模型下载源、转写/角色/合成记录，ctx.media 复制/显式导入素材，ctx.files 生成私有预览 URL，ctx.python 与 ctx.shell 执行可观察本地任务
 * [OUTPUT]: 注册环境检查、Whisper/Qwen 模型安装、转写、通过参考音与声纹验收的声音角色创建、配音合成、历史与用户确认入库 operation；转写可保存为源声音 + SRT + JSON 的 platform transcript 素材
 * [POS]: audio-studio 的唯一业务后端；声音角色须通过质量验收，未选角色时使用 CosyVoice 官方默认声音进入 TTS，输出先停留在 App 文件沙箱，绝不在生成时自动创建素材库 Asset
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

const WHISPER_MODELS = ["whisper-small", "whisper-medium", "whisper-large-v3"];
const QWEN_MODELS = ["qwen3-asr-0.6b", "qwen3-asr-1.7b"];
const ASR_MODELS = new Set([...WHISPER_MODELS, ...QWEN_MODELS]);
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
  ctx.sqlite.execute("create table if not exists audio_settings (key text primary key, value text not null)");
  ctx.sqlite.execute("create table if not exists audio_env_error (id integer primary key check (id = 1), job_id text not null, action text not null, error text not null, logs text not null, updated_at text not null)");
  ensureColumn(ctx, "audio_transcripts", "audio_path", "text not null default ''");
  ensureColumn(ctx, "audio_transcripts", "saved_asset_id", "text not null default ''");
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

function settleOutput(ctx, action, recordID, job) {
  if (!recordID || !isTerminalJob(job.status)) return;
  const table = RECORD_TABLES[action];
  if (!table) return;
  ctx.sqlite.execute(`update ${table} set status = ?, error = ? where id = ?`, [outputStatus(job.status), job.error || job.status, recordID]);
}

function resolveTrackedJob(ctx, record, job) {
  settleOutput(ctx, record.action, record.record_id, job);
  const logs = ctx.shell.logs(record.job_id).slice(-80);
  noteEnvOutcome(ctx, record, job, logs);
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
    settleOutput(ctx, record.action, record.record_id, interrupted);
    noteEnvOutcome(ctx, record, interrupted, []);
    return { id: record.job_id, action: record.action, recordID: record.record_id, startedAt: record.started_at, status: interrupted.status, error: interrupted.error, logs: [] };
  }
  const status = shellJobStatus(job);
  if (!isActiveJob(status) && !isTerminalJob(status)) {
    const interrupted = { status: "interrupted", error: tr(ctx, `任务状态不可识别：${status || "empty"}`, `Task status unrecognized: ${status || "empty"}`) };
    settleOutput(ctx, record.action, record.record_id, interrupted);
    noteEnvOutcome(ctx, record, interrupted, []);
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

function trackJob(ctx, job, action, recordID = "") {
  ensureSchema(ctx);
  const id = shellJobID(job);
  if (!id || !ACTIONS.has(action)) throw new Error("Audio task did not return a valid shell job id.");
  const now = new Date().toISOString();
  ctx.sqlite.execute("update audio_jobs set resolved_at = ? where resolved_at = ''", [now]);
  ctx.sqlite.execute("insert into audio_jobs (job_id, action, record_id, started_at, resolved_at) values (?, ?, ?, ?, '')", [id, action, recordID, now]);
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

function status(_, ctx) {
  const activeJob = trackedJob(ctx);
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
      asr: { installed: [] }, tts: { ready: false }, downloadSource: downloadSource(ctx), activeJob,
      ...(envFailure || {}),
    };
  }
  const runner = run(ctx, ["status"], 20);
  const result = { ...runner, downloadSource: downloadSource(ctx), activeJob };
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
  return { job: trackJob(ctx, ctx.python.prepare(), "prepare") };
}

function install(input, ctx) {
  const selected = value(input, "model");
  const source = value(input, "source") || downloadSource(ctx);
  if (!ASR_MODELS.has(selected) && selected !== "cosyvoice2") throw new Error("model must be an ASR model or cosyvoice2");
  setDownloadSource(ctx, source);
  ensureNoActiveJob(ctx);
  return { job: trackJob(ctx, ctx.python.run(["python/audio_runner.py", "install", "--model", selected, "--source", source]), "install") };
}

function transcribe(input, ctx) {
  ensureSchema(ctx);
  const assetID = value(input, "assetId");
  const kind = value(input, "kind");
  const model = value(input, "model");
  const language = value(input, "language");
  if (!assetID || !KINDS.has(kind) || !ASR_MODELS.has(model) || !LANGUAGES.has(language)) throw new Error("assetId, kind, model and language are required");
  ensureNoActiveJob(ctx);
  const source = ctx.media.materialize(assetID);
  if (source.kind !== kind) throw new Error(`Selected Asset is ${source.kind}, not ${kind}.`);
  const id = outputID();
  const stem = `transcripts/${id}`;
  const record = { id, sourceAssetId: assetID, sourceKind: kind, model, language, srtPath: `${stem}.srt`, jsonPath: `${stem}.json`, audioPath: `${stem}.audio.wav`, savedAssetId: "", duration: 0, createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_transcripts (id, source_asset_id, source_kind, model, language, srt_path, json_path, audio_path, saved_asset_id, duration, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.sourceAssetId, record.sourceKind, record.model, record.language, record.srtPath, record.jsonPath, record.audioPath, record.savedAssetId, record.duration, record.createdAt, record.jobId, record.status, record.error]);
  try {
    const job = ctx.python.run(["python/audio_runner.py", "transcribe", "--model", model, "--language", language, "--input", source.path, "--output", stem]);
    const tracked = trackJob(ctx, job, "transcribe", id);
    record.jobId = shellJobID(tracked);
    ctx.sqlite.execute("update audio_transcripts set job_id = ? where id = ?", [record.jobId, id]);
    return { job: tracked, transcript: { id } };
  } catch (error) {
    markFailed(ctx, "transcribe", id, error);
    throw error;
  }
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
  return ctx.sqlite.query("select id, source_asset_id, source_kind, model, language, duration, created_at, srt_path, json_path, audio_path, saved_asset_id from audio_transcripts where status = 'completed' order by created_at desc").map((row) => transcriptRecord(ctx, row)).filter(Boolean);
}

function transcript(input, ctx) {
  ensureSchema(ctx);
  trackedJob(ctx);
  const id = value(input, "id");
  const rows = ctx.sqlite.query("select id, source_asset_id, source_kind, model, language, duration, created_at, srt_path, json_path, audio_path, saved_asset_id, status, error from audio_transcripts where id = ?", [id]);
  if (!rows.length) throw new Error("Audio transcript was not found.");
  const row = rows[0];
  if (row.status !== "completed") return { id: row.id, status: row.status, error: row.error || "" };
  const record = transcriptRecord(ctx, row);
  if (!record) throw new Error("Audio transcript files are missing.");
  const data = readJSON(ctx, row.json_path) || { segments: [] };
  return { ...record, segments: data.segments || [], srt: ctx.files.readText(row.srt_path) };
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
  try {
    const job = ctx.python.run(["python/audio_runner.py", "character", "--model", model, "--input", source.path, "--output", stem]);
    const tracked = trackJob(ctx, job, "character", id);
    record.jobId = shellJobID(tracked);
    ctx.sqlite.execute("update audio_characters set job_id = ? where id = ?", [record.jobId, id]);
    return { job: tracked, character: { id } };
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
  if (!text) throw new Error("text is required");
  if (!STYLES.has(style)) throw new Error("style must be neutral, calm, excited, or gentle");
  ensureNoActiveJob(ctx);
  const characters = characterID ? ctx.sqlite.query("select id, sample_path, prompt_text from audio_characters where id = ? and status = 'completed'", [characterID]).filter((row) => characterQuality(ctx, row)) : [];
  if (characterID && !characters.length) throw new Error("Selected voice character was not found.");
  const character = characters[0] || { id: "__cosyvoice_default__", sample_path: "", prompt_text: "" };
  const id = outputID();
  const outputPath = `syntheses/${id}.wav`;
  const record = { id, characterId: characterID, text, style, outputPath, mimeType: "audio/wav", savedAssetId: "", createdAt: new Date().toISOString(), jobId: "", status: "queued", error: "" };
  ctx.sqlite.execute("insert into audio_syntheses (id, character_id, text, style, output_path, mime_type, saved_asset_id, created_at, job_id, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.characterId, record.text, record.style, record.outputPath, record.mimeType, record.savedAssetId, record.createdAt, record.jobId, record.status, record.error]);
  try {
    const args = ["python/audio_runner.py", "synthesize", "--text", text, "--style", style, "--output", outputPath];
    if (characterID) args.push("--reference", character.sample_path, "--prompt-text", character.prompt_text);
    else args.push("--default-voice");
    const job = ctx.python.run(args);
    const tracked = trackJob(ctx, job, "synthesize", id);
    record.jobId = shellJobID(tracked);
    ctx.sqlite.execute("update audio_syntheses set job_id = ? where id = ?", [record.jobId, id]);
    return { job: tracked, synthesis: { id } };
  } catch (error) {
    markFailed(ctx, "synthesize", id, error);
    throw error;
  }
}

function synthesisRecord(ctx, row) {
  const record = { id: row.id, characterId: row.character_id, text: row.text, style: row.style, savedAssetId: row.saved_asset_id, createdAt: row.created_at, outputURL: "", duration: 0 };
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
  const rows = ctx.sqlite.query("select id, character_id, text, style, output_path, saved_asset_id, created_at, status, error from audio_syntheses where id = ?", [id]);
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
  return ctx.sqlite.query("select id, character_id, text, style, output_path, saved_asset_id, created_at from audio_syntheses where status = 'completed' order by created_at desc").map((row) => synthesisRecord(ctx, row)).filter(Boolean);
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
