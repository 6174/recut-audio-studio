// L1 回归测试：design/preset 声音角色的自动入库与可合成性。
// 覆盖两个真实回归：
//   1) 角色任务终态即按 saveToLibrary 自动导入素材库（AI 创建后无需人工手动保存）；
//   2) 已完成的 design 角色能被 audio.synthesize 找到（characterQuality 需要 origin）。
// 用 node:sqlite + mock 平台 ctx 驱动 background.js 的真实代码路径。
// 运行：node test/character_library_smoke.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, "..", "background.js"), "utf8");

const ops = {};
const recutMock = { operation: { register: (name, fn) => { ops[name] = fn; } } };

const META = JSON.stringify({
  origin: "design",
  promptText: "深夜一个人，也挺好",
  duration: 8.8,
  sampleRate: 48000,
  fidelity: 0.98,
});

function makeWorld() {
  const db = new DatabaseSync(":memory:");
  const sqlite = {
    execute: (sql, params = []) => { try { db.prepare(sql).run(...params); } catch (e) { if (!String(e.message).includes("duplicate column")) throw e; } },
    query: (sql, params = []) => db.prepare(sql).all(...params),
  };
  const jobs = new Map();
  let seq = 0;
  const mkJob = (tag) => { const id = `sj-${++seq}`; jobs.set(id, { status: "running", error: "", tag }); return { id, status: "running", error: "" }; };
  const shell = {
    status: (id) => { const j = jobs.get(id); if (!j) throw new Error("no such job"); return { id, status: j.status, error: j.error }; },
    logs: () => [],
    cancel: (id) => { const j = jobs.get(id); if (j && j.status === "running") j.status = "cancelled"; },
    exec: () => ({ stdout: JSON.stringify({ ready: true, asr: { installed: ["qwen3-asr-0.6b"] }, tts: { ready: true } }), exitCode: 0 }),
  };
  const python = {
    status: () => ({ ready: true, asr: { installed: ["qwen3-asr-0.6b"] }, tts: { ready: true, engines: { voxcpm: { runtime: true, models: { voxcpm2: { downloaded: true } } } } } }),
    run: (args) => mkJob(`run:${args.join(" ")}`),
  };
  let imported = 0;
  const media = {
    materialize: (assetId) => ({ kind: String(assetId).startsWith("video") ? "video" : "audio", path: `/sandbox/${assetId}.wav` }),
    importFile: () => ({ id: `asset-voice-${++imported}` }),
    importTranscript: () => ({ id: "asset-x" }),
  };
  const files = {
    url: () => "http://preview",
    readText: (p) => (String(p).endsWith(".meta.json") ? META : ""),
  };
  return { ctx: { sqlite, shell, python, media, files, locale: "zh" }, jobs, get imported() { return imported; } };
}

vm.runInNewContext(code, {
  recut: recutMock, console, JSON, Date, Math, Set, Map, Number, String, Boolean, Error,
});

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.log(` FAIL ${name}`); } };
const call = (name, input, ctx) => ops[name](input, ctx);

// S1：design + saveToLibrary 任务终态自动入库（不依赖任何读取 op）
{
  const w = makeWorld();
  const design = call("audio.character.design", { name: "阿蛋", designDesc: "深夜独居青年", model: "qwen3-asr-0.6b", saveToLibrary: true }, w.ctx);
  check("S1 design 提交即派发", design.job !== null && design.character.origin === "design");
  const characterId = design.character.id;
  w.jobs.get(design.job.id).status = "completed";
  call("audio.status", {}, w.ctx); // 结算驱动 pumpQueue
  check("S1 结算后已调用素材库导入", w.imported === 1);

  const rec = call("audio.characters", {}, w.ctx).find((c) => c.id === characterId);
  check("S1 sampleAssetId 已回填（无需人工保存）", rec && rec.sampleAssetId === "asset-voice-1");
  check("S1 promptText 已从 meta 回填", rec && rec.promptText === "深夜一个人，也挺好");

  // S2：已完成的 design 角色必须能被 synthesize 找到（origin 缺失会误判为 clone 而失败）
  const syn = call("audio.synthesize", { characterId, text: "再来一碗", engine: "voxcpm2" }, w.ctx);
  check("S2 design 角色可被 synthesize 找到并派发", syn.job !== null && Boolean(syn.taskId));
  check("S2 未重复导入素材库（幂等）", w.imported === 1);
}

// S3：preset 角色同样可被 synthesize 找到
{
  const w = makeWorld();
  const design = call("audio.character.design", { name: "预设角色", presetId: "jieshuo-xiaoshuai", model: "qwen3-asr-0.6b", saveToLibrary: true }, w.ctx);
  const characterId = design.character.id;
  check("S3 preset 提交即派发", design.job !== null && design.character.origin === "preset");
  w.jobs.get(design.job.id).status = "completed";
  call("audio.status", {}, w.ctx);
  const syn = call("audio.synthesize", { characterId, text: "你好", engine: "voxcpm2" }, w.ctx);
  check("S3 preset 角色可被 synthesize 找到", syn.job !== null && Boolean(syn.taskId));
}

// S4：AI 缺省（不传 saveToLibrary）→ 默认入库
{
  const w = makeWorld();
  const design = call("audio.character.design", { name: "默认入库", designDesc: "深夜独居青年", model: "qwen3-asr-0.6b" }, w.ctx);
  w.jobs.get(design.job.id).status = "completed";
  call("audio.status", {}, w.ctx);
  const rec = call("audio.characters", {}, w.ctx).find((c) => c.id === design.character.id);
  check("S4 缺省 saveToLibrary 默认入库", w.imported === 1 && rec && rec.sampleAssetId === "asset-voice-1");
}

// S5：人工显式 saveToLibrary:false → 不入库，可事后 audio.save
{
  const w = makeWorld();
  const design = call("audio.character.design", { name: "不入库", designDesc: "深夜独居青年", model: "qwen3-asr-0.6b", saveToLibrary: false }, w.ctx);
  w.jobs.get(design.job.id).status = "completed";
  call("audio.status", {}, w.ctx);
  const rec = call("audio.characters", {}, w.ctx).find((c) => c.id === design.character.id);
  check("S5 显式 false 不自动入库", w.imported === 0 && rec && rec.sampleAssetId === "");
  const saved = call("audio.save", { id: design.character.id, kind: "character" }, w.ctx);
  check("S5 事后 audio.save 可入库", saved.assetId === "asset-voice-1" && w.imported === 1);
}

// S6：clone（audio.character.create）缺省默认入库，显式 false 不入库
{
  const w = makeWorld();
  const a = call("audio.character.create", { assetId: "a1", name: "克隆默认", model: "qwen3-asr-0.6b" }, w.ctx);
  w.jobs.get(a.job.id).status = "completed";
  call("audio.status", {}, w.ctx);
  check("S6 clone 缺省默认入库", w.imported === 1);

  const w2 = makeWorld();
  const b = call("audio.character.create", { assetId: "a1", name: "克隆不入库", model: "qwen3-asr-0.6b", saveToLibrary: false }, w2.ctx);
  w2.jobs.get(b.job.id).status = "completed";
  call("audio.status", {}, w2.ctx);
  check("S6 clone 显式 false 不入库", w2.imported === 0);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
