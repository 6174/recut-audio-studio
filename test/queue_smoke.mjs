// L1 冒烟测试：任务队列引擎（rfc/2026-09-03-task-queue-and-parallelism.md）
// 用 node:sqlite + mock 平台 ctx 驱动 background.js 的真实代码路径（与平台相同的 (input, ctx) 调用约定），验证：
//   1) 推理单槽：第二个推理任务入队（返回 job=null）而非被拒绝
//   2) install 不限并行；3) 结算后 FIFO 自动派发
//   4) prepare 等推理排空；5) 依赖守卫（权重下载中 → 同模型推理排队）
//   6) queued 可取消 / running 走平台 cancel；7) audio.status.tasks 契约
// 运行：node test/queue_smoke.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, "..", "background.js"), "utf8");

const ops = {};
const recutMock = { operation: { register: (name, fn) => { ops[name] = fn; } } };

// 每个场景一个全新的内存数据库 + mock 平台对象。
function makeWorld() {
  const db = new DatabaseSync(":memory:");
  const sqlite = {
    execute: (sql, params = []) => { try { db.prepare(sql).run(...params); } catch (e) { if (!String(e.message).includes("duplicate column")) throw e; } },
    query: (sql, params = []) => db.prepare(sql).all(...params),
  };
  const jobs = new Map();
  let seq = 0;
  const mkJob = (tag) => { const id = `sj-${++seq}`; jobs.set(id, { status: "running", error: "", tag }); return { id, status: "running", error: "", startedAt: new Date().toISOString() }; };
  const shell = {
    status: (id) => { const j = jobs.get(id); if (!j) throw new Error("no such job"); return { id, status: j.status, error: j.error }; },
    logs: () => [],
    cancel: (id) => { const j = jobs.get(id); if (j && j.status === "running") j.status = "cancelled"; },
    exec: () => ({ stdout: JSON.stringify({ ready: true, asr: { installed: [] }, tts: { ready: true } }), exitCode: 0 }),
  };
  const python = {
    status: () => ({ ready: true }),
    prepare: () => mkJob("python-prepare"),
    run: (args) => mkJob(`run:${args.join(" ")}`),
  };
  const media = {
    materialize: (assetId) => ({ kind: String(assetId).startsWith("video") ? "video" : "audio", path: `/sandbox/${assetId}.wav` }),
    importFile: () => ({ id: "asset-x" }),
    importTranscript: () => ({ id: "asset-x" }),
  };
  const files = { url: () => "http://preview", readText: () => "" };
  return { ctx: { sqlite, shell, python, media, files, locale: "zh" }, jobs };
}

// 在干净沙箱里执行 background.js，收集注册的 op（平台语义：recut.operation.register）。
vm.runInNewContext(code, {
  recut: recutMock, console, JSON, Date, Math, Set, Map, Number, String, Boolean, Error,
});
if (!ops["audio.status"] || !ops["audio.transcribe"] || !ops["audio.synthesize"] || !ops["audio.prepare"] || !ops["audio.install"] || !ops["audio.task.cancel"]) {
  console.error("FAIL op registration", Object.keys(ops));
  process.exit(1);
}

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.log(` FAIL ${name}`); } };
const call = (name, input, ctx) => ops[name](input, ctx);

// S1：推理单槽 + 排队（job=null）+ status.tasks 契约
{
  const w = makeWorld();
  const a = call("audio.transcribe", { assetId: "a1", kind: "audio", model: "qwen3-asr-0.6b", language: "zh" }, w.ctx);
  check("S1 转写空槽立即派发（job.running）", a.job !== null && a.job.status === "running");
  const b = call("audio.synthesize", { text: "你好", engine: "cosyvoice2" }, w.ctx);
  check("S1 配音占槽时入队（job=null, 有 taskId）", b.job === null && Boolean(b.taskId));
  const st = call("audio.status", {}, w.ctx);
  check("S1 status.tasks 两条在途", st.tasks.length === 2);
  const queued = st.tasks.find((t) => t.action === "synthesize");
  check("S1 配音 queued 且 jobId 空", queued && queued.state === "queued" && queued.jobId === "");
  check("S1 activeJob = 最新在途（配音）", st.activeJob && st.activeJob.action === "synthesize" && st.activeJob.status === "queued" && st.activeJob.id === "");
}

// S2：结算后 FIFO 自动派发；终态离队
{
  const w = makeWorld();
  const a = call("audio.transcribe", { assetId: "a1", kind: "audio", model: "qwen3-asr-0.6b", language: "zh" }, w.ctx);
  const b = call("audio.synthesize", { text: "你好", engine: "cosyvoice2" }, w.ctx);
  w.jobs.get(a.job.id).status = "completed";
  const st = call("audio.status", {}, w.ctx);
  const syn = st.tasks.find((t) => t.id === b.taskId);
  check("S2 转写完成后配音自动派发（running + jobId）", syn && syn.state === "running" && syn.jobId !== "");
  check("S2 终态任务离队", !st.tasks.some((t) => t.id === a.taskId) && st.tasks.length === 1);
}

// S3：install 与推理并行 + 依赖守卫（下载未完 → 同模型推理保持排队）
{
  const w = makeWorld();
  const a = call("audio.transcribe", { assetId: "a1", kind: "audio", model: "qwen3-asr-1.7b", language: "en" }, w.ctx);
  check("S3 转写（1.7b）运行中", a.job !== null);
  const b = call("audio.transcribe", { assetId: "a2", kind: "audio", model: "qwen3-asr-1.7b", language: "en" }, w.ctx);
  check("S3 第二个推理排队", b.job === null);
  const dl = call("audio.install", { model: "qwen3-asr-1.7b" }, w.ctx);
  check("S3 install 立即并行", dl.job !== null && dl.job.status === "running");
  check("S3 三条在途", call("audio.status", {}, w.ctx).tasks.length === 3);
  w.jobs.get(a.job.id).status = "completed";
  let bRow = call("audio.status", {}, w.ctx).tasks.find((t) => t.id === b.taskId);
  check("S3 依赖下载未完 → 保持 queued", bRow && bRow.state === "queued");
  w.jobs.get(dl.job.id).status = "completed";
  bRow = call("audio.status", {}, w.ctx).tasks.find((t) => t.id === b.taskId);
  check("S3 下载完成后自动派发", bRow && bRow.state === "running" && bRow.jobId !== "");
}

// S4：prepare（环境单槽）等推理排空
{
  const w = makeWorld();
  const a = call("audio.synthesize", { text: "你好", engine: "cosyvoice2" }, w.ctx);
  check("S4 配音运行中", a.job !== null);
  const p = call("audio.prepare", { target: "voxcpm" }, w.ctx);
  check("S4 prepare 入队", p.job === null);
  w.jobs.get(a.job.id).status = "completed";
  const pRow = call("audio.status", {}, w.ctx).tasks.find((t) => t.id === p.taskId);
  check("S4 推理排空后 prepare 派发", pRow && pRow.state === "running");
}

// S5：取消排队任务（无 shell job）
{
  const w = makeWorld();
  const a = call("audio.synthesize", { text: "占槽", engine: "cosyvoice2" }, w.ctx);
  const b = call("audio.transcribe", { assetId: "a1", kind: "audio", model: "whisper-small", language: "zh" }, w.ctx);
  check("S5 转写排队", b.job === null);
  const c = call("audio.task.cancel", { id: b.taskId }, w.ctx);
  check("S5 queued 可取消", c.cancelled === true);
  check("S5 取消后离队", !call("audio.status", {}, w.ctx).tasks.some((t) => t.id === b.taskId));
}

// S6：取消运行任务（平台 cancel）→ 落 cancelled 终态
{
  const w = makeWorld();
  const a = call("audio.synthesize", { text: "你好", engine: "cosyvoice2" }, w.ctx);
  const c = call("audio.task.cancel", { id: a.taskId }, w.ctx);
  check("S6 running 走平台 cancel", c.cancelled === true && w.jobs.get(a.job.id).status === "cancelled");
  const st = call("audio.status", {}, w.ctx);
  check("S6 无在途（cancelled 为终态）", st.tasks.length === 0);
}

// S7：audio.tasks.list 也驱动 pump（排队行出现在列表）
{
  const w = makeWorld();
  const a = call("audio.synthesize", { text: "占槽", engine: "cosyvoice2" }, w.ctx);
  const b = call("audio.transcribe", { assetId: "a1", kind: "audio", model: "whisper-small", language: "zh" }, w.ctx);
  const list = call("audio.tasks.list", { status: "queued" }, w.ctx);
  check("S7 list(queued) 含排队转写", list.tasks.length === 1 && list.tasks[0].id === b.taskId);
  const running = call("audio.tasks.list", { status: "running" }, w.ctx);
  check("S7 list(running) 含配音", running.tasks.length === 1 && running.tasks[0].id === a.taskId);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
