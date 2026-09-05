/**
 * [INPUT]: 依赖 recut-sdk、i18n、lib/options（speechModels/draft 读写/ActiveJob）、lib/format（isTerminal/TERMINAL_TASK_STATES/isValidActiveJob/jobStartedAt/mergeLogs/kindLabel）与 ./store（useAppStore）
 * [OUTPUT]: 全局业务动作（全部基于 useAppStore.getState()/setState()，无组件闭包）：任务中心（featureState/featureBusy/loadTasks/selectTask/cancelTaskById/announceTaskEnd）、运行时刷新（refresh/loadAssets）、任务执行（beginJob/restoreJob/syncJob/finishJob）、安装与环境（installSpeechModel/installCosyVoice/installVoxCpm/prepareTarget/changeDownloadSource）、素材来源（chooseSource/chooseCharacterSource/upload）、业务提交（transcribeSource/createCharacter/designCharacter/synthesizeVoice）、入库与角色（saveTranscript/saveSynthesis/saveCharacter/removeCharacter/askAgent/updateSegmentText）、预设试听（playPreset/preparePreset，含模块级试听音频与已就绪 URL 缓存）
 * [POS]: audio-studio 的编排逻辑层；main.tsx 只保留 effect 订阅与 JSX，动作经 import 调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { recut } from "../recut-sdk";
import { t, tF } from "../i18n";
import { saveSynthesisDraft, speechModels } from "../lib/options";
import { TERMINAL_TASK_STATES, isTerminal, isValidActiveJob, jobStartedAt, kindLabel, mergeLogs } from "../lib/format";
import type { ActiveAudioJob, DesignCharacterResult, MediaAsset, ShellJob, ShellJobLog, SpeechModel, Synthesis, TaskAction, TaskListResult, TaskLogResult, TaskSummary, TranscriptDetail, TranscriptSummary, VoiceCharacter, VoxCpmVersion } from "../types";
import { useAppStore, type TaskFilter } from "./store";

const S = () => useAppStore.getState();

// 预设试听：私有音频元素与已就绪 URL 缓存（组件生命周期之外）。
const previewAudio: { current: HTMLAudioElement | null } = { current: null };
const preparedPresetURLs = new Map<string, string>();
// 终态去重与收尾中的 job（防止重复通告/重复 finish）。
const notifiedTasks = new Set<string>();
const finalizingJob: { current: string | null } = { current: null };

// ---- 任务中心派生态 ----

export function featureState(activeTasks: TaskSummary[], actions: TaskAction[]): "running" | "queued" | null {
  const list = activeTasks.filter((task) => actions.includes(task.action) && !TERMINAL_TASK_STATES.has(task.state));
  return list.some((task) => task.state === "running") ? "running" : list.length ? "queued" : null;
}

export function featureBusy(activeTasks: TaskSummary[], actions: TaskAction[], localActions: string[]) {
  if (featureState(activeTasks, actions) !== null) return actions[0];
  const busy = S().busy;
  if (busy && localActions.includes(busy)) return actions[0];
  return null;
}

export async function loadTasks(filter: TaskFilter) {
  const { locale, setTasks, setSelectedTask } = S();
  try {
    const result = await recut.background.call("audio.tasks.list", {
      ...(filter === "running" ? { status: "running" } : filter === "queued" ? { status: "queued" } : filter === "completed" ? { status: "done" } : filter === "failed" ? { status: "failed" } : {}),
      limit: 100,
    }) as TaskListResult;
    setTasks(result.tasks);
    setSelectedTask((current) => current && result.tasks.some((item) => item.id === current.id) ? result.tasks.find((item) => item.id === current.id)! : current);
  } catch (error) { S().setMessage(error instanceof Error ? error.message : t(locale, "msg.readTasksFailed")); }
}

export async function selectTask(task: TaskSummary) {
  const { setTaskLogs, setTaskResult, setCharacters, setCharactersLoading, setSyntheses } = S();
  S().setSelectedTask(task);
  try { const result = await recut.background.call("audio.task.logs", { id: task.id, limit: 300 }) as TaskLogResult; setTaskLogs(result.logs); }
  catch { setTaskLogs([]); }
  // 结果直接在详情面板内渲染（不再二次弹框）。仅当任务已完成（产出就绪）才取产物，避免「进行中」返回 {id,status,error} 无 segments。
  if (!task.recordId || task.state !== "completed") { setTaskResult(() => null); return; }
  try {
    if (task.action === "transcribe") {
      const detail = await recut.background.call("audio.transcript", { id: task.recordId }) as TranscriptDetail;
      setTaskResult(() => detail && Array.isArray(detail.segments) ? { kind: "transcript", item: detail } : null);
    } else if (task.action === "character" || task.action === "design") {
      // 任务完成后现拉一次角色列表：任务账本完成晚于启动时的快照，不刷新会找不到新角色。
      const [fresh, synthesesNow] = await Promise.all([
        recut.state.query("audio.characters") as Promise<VoiceCharacter[]>,
        recut.state.query("audio.syntheses") as Promise<Synthesis[]>,
      ]);
      setCharacters(() => fresh);
      setSyntheses(() => synthesesNow);
      setCharactersLoading(false);
      const character = (fresh || []).find((item) => item.id === task.recordId);
      setTaskResult(() => character ? { kind: "character", item: character } : null);
    } else if (task.action === "synthesize") {
      const synthesisNow = await (recut.state.query("audio.syntheses") as Promise<Synthesis[]>).then((items) => items.find((item) => item.id === task.recordId));
      if (synthesisNow) setSyntheses((items) => items.some((item) => item.id === synthesisNow.id) ? items.map((item) => item.id === synthesisNow.id ? synthesisNow : item) : [...items, synthesisNow]);
      setTaskResult(() => synthesisNow ? { kind: "synthesis", item: synthesisNow } : null);
    } else { setTaskResult(() => null); }
  } catch { setTaskResult(() => null); }
}

export async function cancelTaskById(id: string) {
  const { locale, setMessage } = S();
  try { await recut.background.call("audio.task.cancel", { id }); void loadTasks(S().taskFilter); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.stopFailed")); }
}

// 离队（终态）任务的通告：按 action 弹消息 + 角色/设计成功后切「管理」视图；notifiedTasks 去重防重复 toast。
export function announceTaskEnd(task: TaskSummary) {
  const { locale, setMessage, setFailure } = S();
  if (task.state === "completed") {
    switch (task.action) {
      case "transcribe": setMessage(t(locale, "msg.transcribeDone")); break;
      case "character": setMessage(t(locale, "msg.characterCreated")); S().setCharactersView("manage"); S().setViewCharacter(null); break;
      case "design": setMessage(t(locale, "msg.designDone")); S().setCharactersView("manage"); S().setViewCharacter(null); break;
      case "synthesize": setMessage(t(locale, "msg.synthesisDone")); break;
      case "prepare": setMessage(t(locale, "msg.envReady")); break;
      default: setMessage(t(locale, "msg.modelInstalled"));
    }
  } else {
    const error = task.error || t(locale, task.state === "cancelled" ? "msg.taskCancelled" : "msg.taskFailed");
    setFailure(error); setMessage(error);
  }
  void loadTasks(S().taskFilter);
}

// ---- 运行时刷新 ----

export async function refresh(): Promise<ReturnType<typeof S>["status"]> {
  const { locale, setMessage } = S();
  try {
    const nextStatus = await recut.state.query("audio.status") as NonNullable<ReturnType<typeof S>["status"]>;
    S().setStatus(nextStatus);
    if (nextStatus.downloadSource) S().setDownloadSource(nextStatus.downloadSource);
    // 任务队列同步（RFC task-queue）：刷新在途清单，diff 通告终态任务（功能级状态随之更新）。
    const nextTasks = nextStatus.tasks ?? [];
    for (const prev of S().activeTasks) {
      if (nextTasks.some((task) => task.id === prev.id)) continue;
      if (notifiedTasks.has(prev.id)) continue;
      notifiedTasks.add(prev.id);
      announceTaskEnd(prev);
    }
    S().setActiveTasks(nextTasks);
    const hasRunning = nextTasks.some((task) => task.state === "running");
    setMessage(nextStatus.activeJob && isValidActiveJob(nextStatus.activeJob) ? t(locale, "msg.jobRunning") : nextTasks.length ? t(locale, hasRunning ? "msg.jobRunning" : "msg.queuedRunning") : nextStatus.ready ? t(locale, "msg.ready") : nextStatus.setupError ? tF(locale, "msg.setupFailed", { error: nextStatus.setupError }) : t(locale, "msg.starting"));
    try {
      const [nextCharacters, nextSyntheses] = await Promise.all([
        recut.state.query("audio.characters") as Promise<VoiceCharacter[]>,
        recut.state.query("audio.syntheses") as Promise<Synthesis[]>,
      ]);
      S().setCharacters(() => nextCharacters); S().setSyntheses(() => nextSyntheses);
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.readHistoryFailed")); }
    finally { S().setCharactersLoading(false); }
    return nextStatus;
  } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.readStatusFailed")); }
  return null;
}

export async function loadAssets(): Promise<MediaAsset[]> {
  const { locale } = S();
  const response = await fetch("/v1/media/assets");
  if (!response.ok) throw new Error(t(locale, "msg.readLibraryFailed"));
  const next = await response.json() as MediaAsset[];
  const completed = next.filter((asset) => asset.status === "completed" && (asset.kind === "audio" || asset.kind === "video"));
  S().setAssets(() => completed); return completed;
}

// ---- 任务执行 ----

export function restoreJob(job: ActiveAudioJob) {
  if (!isValidActiveJob(job)) return;
  const { setLogs, setElapsedSeconds, setBusy, setActiveJob } = S();
  setLogs(job.logs);
  setElapsedSeconds(Math.floor((Date.now() - jobStartedAt(job.startedAt)) / 1000));
  setBusy(job.action);
  setActiveJob(() => ({ id: job.id, action: job.action, recordID: job.recordID, startedAt: jobStartedAt(job.startedAt), status: job.status, error: job.error }));
}

export async function syncJob() {
  const job = await recut.state.query("audio.job") as ActiveAudioJob | null;
  if (job && job.id && isValidActiveJob(job)) restoreJob(job);
  else if (job && job.status === "queued") { /* 排队中（未派发、无 shell job）：保持当前进度显示不动 */ }
  else { S().setActiveJob(() => null); S().setBusy(null); }
}

export function beginJob(job: ShellJob | null | undefined, action: ActiveAudioJob["action"], recordID?: string) {
  const { locale, setMessage } = S();
  // job=null 表示已排队（后端单槽被占）：不建立进度视图，仅刷新任务列表（排队徽标由 activeTasks 驱动）。
  if (!job) { void loadTasks(S().taskFilter); return; }
  S().setElapsedSeconds(0);
  S().setActiveJob(() => ({ id: job.id, action, recordID, startedAt: jobStartedAt(job.startedAt), status: job.status, error: job.error }));
  void loadTasks(S().taskFilter);
  void syncJob().catch((error) => setMessage(error instanceof Error ? error.message : t(locale, "msg.jobLogFailed")));
}

export async function finishJob(job: NonNullable<ReturnType<typeof S>["activeJob"]>) {
  const { locale, setMessage, setFailure } = S();
  if (finalizingJob.current === job.id) return;
  finalizingJob.current = job.id;
  try {
    if (job.status !== "completed") {
      const tail = [...S().logs].reverse().map((entry) => entry.text.trim()).find(Boolean);
      const error = tail || job.error || t(locale, "msg.taskIncomplete");
      setFailure(error); setMessage(error);
    } else if (job.action === "transcribe" && job.recordID) {
      await recut.background.call("audio.transcript", { id: job.recordID });
      setMessage(t(locale, "msg.transcribeDone"));
    } else if ((job.action === "character" || job.action === "design") && job.recordID) {
      await recut.background.call("audio.character.complete", { id: job.recordID });
      setMessage(t(locale, job.action === "design" ? "msg.designDone" : "msg.characterCreated"));
      // 角色创建/设计成功后自动切到「管理」视图，新角色立即可见。
      S().setCharactersView("manage"); S().setViewCharacter(null);
    } else if (job.action === "synthesize" && job.recordID) {
      await recut.background.call("audio.synthesis.complete", { id: job.recordID });
      setMessage(t(locale, "msg.synthesisDone"));
    } else {
      const nextStatus = await refresh();
      if (!nextStatus?.ready) {
        const error = nextStatus?.error || t(locale, "msg.envCheckPending");
        setFailure(error); setMessage(error); return;
      }
      setMessage(job.action === "prepare" ? t(locale, "msg.envReady") : t(locale, "msg.modelInstalled"));
    }
  } catch (error) { const message = error instanceof Error ? error.message : t(locale, "msg.refreshFailed"); setFailure(message); setMessage(message); }
  finally {
    try { await recut.background.call("audio.resolve", { id: job.id }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.resolveFailed")); }
    S().setBusy(null); S().setActiveJob((current) => current?.id === job.id ? null : current); finalizingJob.current = null;
    void refresh();
  }
}

// ---- 安装与环境 ----

export async function installSpeechModel(selected: SpeechModel = S().model) {
  const { locale, setMessage, setFailure } = S();
  const { setBusy, setLogs } = S();
  setBusy("install"); setFailure(""); setLogs([]);
  setMessage(tF(locale, "msg.downloadingModel", { name: speechModels.find((item) => item.id === selected)?.label ?? selected }));
  try { const result = await recut.background.call("audio.install", { model: selected, source: S().downloadSource }) as { job: ShellJob; taskId: string }; beginJob(result.job, "install"); focusNewTask(result.taskId, "install", "", { type: "ASR 模型", model: selected }); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
}

export async function installCosyVoice() {
  const { locale, setMessage, setFailure, setBusy, setLogs } = S();
  setBusy("install"); setFailure(""); setLogs([]);
  setMessage(t(locale, "msg.downloadingCosyVoice"));
  try { const result = await recut.background.call("audio.install", { model: "cosyvoice2", source: S().downloadSource }) as { job: ShellJob; taskId: string }; beginJob(result.job, "install"); focusNewTask(result.taskId, "install", "", { type: "TTS 模型", model: "cosyvoice2" }); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
}

export async function installVoxCpm(version: VoxCpmVersion) {
  const { locale, setMessage, setFailure, setBusy, setLogs, status } = S();
  const model = status?.tts?.engines?.voxcpm?.models[version] ?? null;
  const label = model?.label ?? version;
  const sizeGb = model?.sizeGb ?? 0;
  setBusy("install"); setFailure(""); setLogs([]);
  setMessage(tF(locale, "msg.downloadingVoxCpm", { label, size: sizeGb.toFixed(1) }));
  try { const result = await recut.background.call("audio.install", { model: version, source: S().downloadSource }) as { job: ShellJob; taskId: string }; beginJob(result.job, "install"); focusNewTask(result.taskId, "install", "", { type: "TTS 模型", model: version, sizeGb }); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
}

// 定向环境准备（设置面板）：all=全量 / cosyvoice / voxcpm；主 venv 缺失时只能走 Setup 的全量路径。
export async function prepareTarget(target: "all" | "cosyvoice" | "voxcpm") {
  const { locale, setMessage, setFailure, setBusy, setLogs } = S();
  setBusy("prepare"); setFailure(""); setLogs([]);
  setMessage(target === "all" ? t(locale, "msg.starting") : tF(locale, "msg.preparingRuntime", { name: target === "voxcpm" ? "VoxCPM" : "CosyVoice" }));
  try { const result = await recut.background.call("audio.prepare", { target }) as { job: ShellJob | null; taskId: string }; beginJob(result.job, "prepare"); focusNewTask(result.taskId, "prepare", "", { type: "运行环境", target }, result.job ? "running" : "queued"); if (!result.job) setMessage(t(locale, "msg.jobQueued")); }
  catch (error) { const message = error instanceof Error ? error.message : t(locale, "msg.startFailed"); setFailure(message); setMessage(message); setBusy(null); }
}

export async function changeDownloadSource(source: NonNullable<ReturnType<typeof S>["downloadSource"]>) {
  const { locale, setMessage } = S();
  try {
    const result = await recut.background.call("audio.settings.set", { downloadSource: source }) as { downloadSource: typeof source };
    S().setDownloadSource(result.downloadSource);
  } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.settingsFailed")); }
}

export function focusNewTask(taskId: string, action: TaskAction, recordId: string, meta: TaskSummary["meta"], state: TaskSummary["state"] = "running") {
  S().setLauncherOpen(null);
  const placeholder: TaskSummary = { id: taskId, action, name: "", recordId, source: "manual", submittedBy: "", state, progress: 0, createdAt: new Date().toISOString(), meta };
  S().setSelectedTask(placeholder);
  void selectTask(placeholder);
}

// ---- 素材来源 ----

export async function chooseSource(kinds: string[]) {
  const { locale, setMessage } = S();
  try {
    const selected = await recut.media.pick(kinds) as MediaAsset | null;
    if (!selected) return;
    S().setAssets((items) => items.some((asset) => asset.id === selected.id) ? items : [selected, ...items]);
    S().setSelectedAsset(selected); S().setAssetId(selected.id); S().setSourceKind(selected.kind === "video" ? "video" : "audio"); setMessage(tF(locale, "msg.pickedSource", { kind: kindLabel(locale, selected.kind), name: selected.name }));
  } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.pickerFailed")); }
}

export async function chooseCharacterSource() {
  const { locale, setMessage } = S();
  try {
    const selected = await recut.media.pick(["audio"]) as MediaAsset | null;
    if (!selected) return;
    S().setAssets((items) => items.some((asset) => asset.id === selected.id) ? items : [selected, ...items]);
    S().setCharacterAsset(selected); S().setCharacterAssetId(selected.id); setMessage(tF(locale, "msg.pickedReference", { name: selected.name }));
  } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.pickerFailed")); }
}

export async function upload(file: File | undefined, kind: "source" | "character") {
  const { locale, setMessage } = S();
  const { setBusy } = S();
  if (!file) return;
  if (!/^(audio|video)\//.test(file.type)) return setMessage(t(locale, "msg.uploadAudioOnly"));
  setBusy("upload");
  try {
    const form = new FormData(); form.append("file", file);
    const response = await fetch("/v1/media/assets", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({})) as { id?: string; error?: string };
    if (!response.ok || !payload.id) throw new Error(payload.error || t(locale, "msg.uploadFailed"));
    const nextAssets = await loadAssets();
    const selected = nextAssets.find((asset) => asset.id === payload.id) ?? { id: payload.id, name: file.name, kind: "audio", mimeType: file.type, status: "completed" } as MediaAsset;
    if (kind === "character") { S().setCharacterAsset(selected); S().setCharacterAssetId(payload.id); }
    else { S().setSelectedAsset(selected); S().setAssetId(payload.id); S().setSourceKind(selected.kind === "video" ? "video" : "audio"); }
    setMessage(t(locale, "msg.uploadedSelected"));
  } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.uploadFailed")); }
  finally { setBusy(null); }
}

// ---- 业务提交 ----

export async function transcribeSource() {
  const { locale, setMessage, assetId, sourceKind, model, language } = S();
  const { setBusy, setFailure, setLogs } = S();
  if (!assetId) return setMessage(t(locale, "msg.pickSourceFirst"));
  setBusy("transcribe"); setFailure(""); setLogs([]);
  setMessage(sourceKind === "video" ? t(locale, "msg.extractingVideo") : t(locale, "msg.transcribing"));
  try { const result = await recut.background.call("audio.transcribe", { assetId, kind: sourceKind, model, language }) as { job: ShellJob | null; taskId: string; transcript: { id: string } }; beginJob(result.job, "transcribe", result.transcript.id); focusNewTask(result.taskId, "transcribe", result.transcript.id, { type: "转写", model, language, sourceAssetId: assetId, sourceKind }, result.job ? "running" : "queued"); if (!result.job) setMessage(t(locale, "msg.jobQueued")); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.transcribeFailed")); setBusy(null); }
}

export async function createCharacter() {
  const { locale, setMessage, characterAssetId, characterName, model } = S();
  const { setBusy, setFailure, setLogs } = S();
  if (!characterAssetId) return setMessage(t(locale, "msg.pickReferenceFirst"));
  if (!characterName.trim()) return setMessage(t(locale, "msg.nameCharacter"));
  setBusy("character"); setFailure(""); setLogs([]);
  setMessage(t(locale, "msg.creatingCharacter"));
  try { const result = await recut.background.call("audio.character.create", { assetId: characterAssetId, name: characterName.trim(), model }) as { job: ShellJob | null; taskId: string; character: { id: string } }; beginJob(result.job, "character", result.character.id); focusNewTask(result.taskId, "character", result.character.id, { type: "声音角色", model, characterName: characterName.trim(), sourceAssetId: characterAssetId }, result.job ? "running" : "queued"); if (!result.job) setMessage(t(locale, "msg.jobQueued")); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.characterFailed")); setBusy(null); }
}

export async function designCharacter(input: { name: string; designDesc?: string; presetId?: string; saveToLibrary: boolean }) {
  const { locale, setMessage, model } = S();
  const { setBusy, setFailure, setLogs } = S();
  setBusy("character"); setFailure(""); setLogs([]);
  setMessage(t(locale, "msg.designing"));
  try {
    const result = await recut.background.call("audio.character.design", { name: input.name, ...(input.designDesc ? { designDesc: input.designDesc } : {}), ...(input.presetId ? { presetId: input.presetId } : {}), saveToLibrary: input.saveToLibrary, model }) as DesignCharacterResult;
    beginJob(result.job, "design", result.character.id);
    focusNewTask(result.taskId, "design", result.character.id, { type: "设计声音", model, characterName: input.name, ...(input.presetId ? { presetId: input.presetId } : {}), ...(input.designDesc ? { designDesc: input.designDesc.slice(0, 60) } : {}) }, result.job ? "running" : "queued");
    if (!result.job) setMessage(t(locale, "msg.jobQueued"));
  } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.designFailed")); setBusy(null); }
}

export async function synthesizeVoice() {
  const { locale, setMessage, synthesisText, synthesisCloud, synthesisCharacterId, synthesisPresetId, style, engine, voxcpmVersion } = S();
  const { setBusy, setFailure, setLogs, setCloudBusy, setCloudResult } = S();
  if (!synthesisText.trim()) return setMessage(t(locale, "msg.enterText"));
  const effectiveEngine = engine === "cosyvoice2" ? "cosyvoice2" : voxcpmVersion;
  const engineNeedsCharacter = engine === "voxcpm" && voxcpmVersion !== "voxcpm2";
  if (synthesisCloud) {
    // 云端 provider 声音：直连 modelId + credentialId 提交平台语音任务；产物天然入素材库。
    setCloudResult(null); setFailure(""); setCloudBusy(true);
    setMessage(t(locale, "dubbing.cloud.progress"));
    try {
      const response = await fetch("/v1/media/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: "speech.generate", modelId: synthesisCloud.modelId, credentialId: synthesisCloud.credentialId, prompt: synthesisText, output: { voiceId: synthesisCloud.voiceId }, idempotencyKey: `dubbing-${Date.now()}-${Math.random().toString(36).slice(2)}` }) });
      const job = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok || !job.id) throw new Error(job.error || t(locale, "msg.synthesisFailed"));
      S().setCloudJob({ id: job.id, name: synthesisCloud.name });
    } catch (error) {
      setCloudBusy(false);
      setMessage(tF(locale, "dubbing.cloud.failed", { error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (engineNeedsCharacter && !synthesisCharacterId && !synthesisPresetId) return setMessage(t(locale, "msg.pickReferenceForVoxCpm"));
  saveSynthesisDraft({ text: synthesisText, characterId: synthesisCharacterId, presetId: synthesisPresetId, cloud: null, style, engine, voxcpmVersion });
  setBusy("synthesize"); setFailure(""); setLogs([]);
  setMessage(t(locale, "msg.synthesizing"));
  // presetId 与 characterId 互斥：选中预设时只提交 presetId（未缓存的由后端在提交时自动 resolve 下载）。
  try { const result = await recut.background.call("audio.synthesize", { ...(synthesisPresetId ? { presetId: synthesisPresetId } : synthesisCharacterId ? { characterId: synthesisCharacterId } : {}), text: synthesisText, style, engine: effectiveEngine }) as { job: ShellJob | null; taskId: string; synthesis: { id: string } }; beginJob(result.job, "synthesize", result.synthesis.id); focusNewTask(result.taskId, "synthesize", result.synthesis.id, { type: "配音合成", engine: effectiveEngine, characterId: synthesisCharacterId, ...(synthesisPresetId ? { presetId: synthesisPresetId } : {}) }, result.job ? "running" : "queued"); if (!result.job) setMessage(t(locale, "msg.jobQueued")); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.synthesisFailed")); setBusy(null); }
}

// ---- 入库与角色 ----

export async function saveTranscript(transcript: Pick<TranscriptSummary, "id">) {
  const { locale, setMessage } = S();
  const { setBusy } = S();
  setBusy("save");
  try { const result = await recut.background.call("audio.save", { id: transcript.id, kind: "transcript" }) as { assetId: string }; S().setTaskResult((current) => current?.kind === "transcript" && current.item.id === transcript.id ? { kind: "transcript", item: { ...(current.item as TranscriptDetail), savedAssetId: result.assetId } } : current); setMessage(t(locale, "msg.transcriptSaved")); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
  finally { setBusy(null); }
}

export async function saveSynthesis(synthesis: Synthesis) {
  const { locale, setMessage } = S();
  const { setBusy } = S();
  setBusy("save");
  try { const result = await recut.background.call("audio.save", { id: synthesis.id, kind: "synthesis" }) as { assetId: string }; S().setSyntheses((items) => items.map((item) => item.id === synthesis.id ? { ...item, savedAssetId: result.assetId } : item)); S().setTaskResult((current) => current?.kind === "synthesis" && current.item.id === synthesis.id ? { kind: "synthesis", item: { ...(current.item as Synthesis), savedAssetId: result.assetId } } : current); setMessage(t(locale, "msg.synthesisSaved")); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
  finally { setBusy(null); }
}

export async function saveCharacter(character: VoiceCharacter) {
  const { locale, setMessage } = S();
  const { setBusy } = S();
  setBusy("save");
  try { const result = await recut.background.call("audio.save", { id: character.id, kind: "character" }) as { assetId: string }; S().setCharacters((items) => items.map((item) => item.id === character.id ? { ...item, sampleAssetId: result.assetId } : item)); S().setTaskResult((current) => current?.kind === "character" && current.item.id === character.id ? { kind: "character", item: { ...(current.item as VoiceCharacter), sampleAssetId: result.assetId } } : current); setMessage(t(locale, "msg.characterSampleSaved")); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
  finally { setBusy(null); }
}

export async function removeCharacter(character: VoiceCharacter) {
  const { locale, setMessage } = S();
  try {
    await recut.background.call("audio.character.remove", { id: character.id });
    S().setCharacters((items) => items.filter((item) => item.id !== character.id));
    S().setViewCharacter(null);
    S().setCharactersView("manage");
    setMessage(t(locale, "msg.characterRemoved"));
    void refresh();
  } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.removeFailed")); }
}

export async function askAgent() {
  const { locale, setMessage, message, status } = S();
  const { setBusy } = S();
  setBusy("agent");
  const details = (status?.setupLogs ?? []).map((entry) => entry.text).join("").slice(-2000);
  const context = status?.setupError || status?.error || message;
  const pythonHint = status?.pythonVersion ? tF(locale, "agent.pythonHint", { version: status.pythonVersion }) : "";
  try { await recut.agent.compose(tF(locale, "agent.prompt", { error: context, pythonHint, logs: details || t(locale, "agent.noLogs") })); setMessage(t(locale, "msg.agentDiagnosisFilled")); }
  catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.agentDiagnosisFailed")); }
  finally { setBusy(null); }
}

export function updateSegmentText(index: number, text: string) {
  S().setTaskResult((current) => {
    if (current?.kind !== "transcript") return current;
    const transcript = current.item as TranscriptDetail;
    return { kind: "transcript", item: { ...transcript, segments: transcript.segments.map((segment, cursor) => cursor === index ? { ...segment, text } : segment) } };
  });
}

// ---- 预设试听 ----

function playPreset(presetId: string, url: string) {
  const { setPlayingPresetId, playingPresetId } = S();
  const current = previewAudio.current;
  if (current && playingPresetId === presetId) {
    if (current.paused) { void current.play().catch(() => {}); setPlayingPresetId(presetId); }
    else { current.pause(); setPlayingPresetId(""); }
    return;
  }
  current?.pause();
  const audio = new Audio(url);
  audio.onended = () => setPlayingPresetId((id) => (id === presetId ? "" : id));
  previewAudio.current = audio;
  void audio.play().catch(() => {});
  setPlayingPresetId(presetId);
}

// 预设试听：后台按需准备参考音（缓存查 → CDN 下载 + sha256 校验），完成后直接播放私有预览地址；
// 再次点击同一预设可暂停/继续；选中也静默触发一次，提前把所选预设下载到本地缓存。
export async function preparePreset(presetId: string, announce: boolean) {
  const { locale, setMessage, playingPresetId, preparingPresetId } = S();
  const { setPlayingPresetId, setPreparingPresetId } = S();
  if (!presetId) return;
  if (announce) {
    const current = previewAudio.current;
    if (current && playingPresetId === presetId) {
      if (current.paused) { void current.play().catch(() => {}); setPlayingPresetId(presetId); }
      else { current.pause(); setPlayingPresetId(""); }
      return;
    }
    // 已就绪过的预设直接复用 preview 地址，不再走后台 op。
    const ready = preparedPresetURLs.get(presetId);
    if (ready) { playPreset(presetId, ready); return; }
    if (preparingPresetId) return;
    setPreparingPresetId(presetId);
  }
  try {
    const result = await recut.background.call("audio.preset.prepare", { presetId }) as { previewURL: string };
    preparedPresetURLs.set(presetId, result.previewURL);
    if (announce) playPreset(presetId, result.previewURL);
  } catch (error) {
    if (announce) setMessage(tF(locale, "preset.prepareFailed", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    if (announce) setPreparingPresetId("");
  }
}

// ---- 事件接入（供 main.tsx 的 effect 使用） ----

export function appendJobLog(log: ShellJobLog) {
  const activeJob = S().activeJob;
  if (log.jobId !== activeJob?.id) return;
  S().setLogs((items) => mergeLogs(items, [log]));
}

export function markJobCompleted(job?: { id: string; status: string; error?: string }) {
  if (!job) return;
  S().setActiveJob((current) => current && current.id === job.id ? { ...current, status: (job.status ?? current.status) as typeof current.status, error: job.error } : current);
}

export function draftFromStore() {
  const { synthesisText, synthesisCharacterId, synthesisPresetId, synthesisCloud, style, engine, voxcpmVersion } = S();
  saveSynthesisDraft({ text: synthesisText, characterId: synthesisCharacterId, presetId: synthesisPresetId, cloud: synthesisCloud, style, engine, voxcpmVersion });
}

export { isTerminal };
