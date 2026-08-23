/**
 * [INPUT]: 依赖 Recut SDK、声音工坊 operation、平台素材选择器、素材库上传 HTTP、shadcn/ui 组件与 React 状态
 * [OUTPUT]: 对外提供三步声音工作流导航、会话级配音草稿、Download Source、Whisper/Qwen/CosyVoice 模型下载、转写文稿与 SRT、转写保存为素材库 bundle、声音角色创建/试听/删除、角色配音合成与试听，以及历史小卡片点击后在共享详情预览中操作、实时计时/日志、任务停止和用户确认入库工作台
 * [POS]: audio-studio UI 编排层；仅在环境和选定模型就绪后开放推理，生成结果先留在 App 私有文件区；UI 用户可见文案经 i18n.ts 随 locale 切换
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleStop, Clock3, Copy, Download, FileAudio, FolderOpen, LoaderCircle, MessageSquareText, Mic, Save, Send, Sparkles, Trash2, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { recut, useRecutLocale, type Locale } from "./recut-sdk";
import type { TaskAction, TaskListResult, TaskLogEntry, TaskLogResult, TaskState, TaskSummary } from "./types";
import { t, tF, type I18nKey } from "./i18n";
import type { ActiveAudioJob, DownloadSource, Language, MediaAsset, RuntimeStatus, ShellJob, ShellJobLog, SpeechModel, Synthesis, TranscriptDetail, TranscriptSegment, TranscriptSummary, TtsEngine, VoiceCharacter, VoiceStyle, VoxCpmEngineStatus, VoxCpmVersion } from "./types";
import "./index.css";

type Tab = "transcribe" | "characters" | "synthesize";
type EngineFamily = "cosyvoice2" | "voxcpm";

const speechModels: { id: SpeechModel; label: string; noteKey: I18nKey }[] = [
  { id: "qwen3-asr-0.6b", label: "Qwen3 ASR 0.6B", noteKey: "model.qwen3-0.6b.note" },
  { id: "qwen3-asr-1.7b", label: "Qwen3 ASR 1.7B", noteKey: "model.qwen3-1.7b.note" },
  { id: "whisper-small", label: "Whisper Small", noteKey: "model.whisper-small.note" },
  { id: "whisper-medium", label: "Whisper Medium", noteKey: "model.whisper-medium.note" },
  { id: "whisper-large-v3", label: "Whisper Large-v3", noteKey: "model.whisper-large-v3.note" },
];

const downloadSources: { id: DownloadSource; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "automatic", labelKey: "downloadSource.automatic", noteKey: "downloadSource.automatic.note" },
  { id: "huggingface", labelKey: "downloadSource.huggingface", noteKey: "downloadSource.huggingface.note" },
  { id: "modelscope", labelKey: "downloadSource.modelscope", noteKey: "downloadSource.modelscope.note" },
];

const languages: { id: Language; labelKey: I18nKey }[] = [
  { id: "auto", labelKey: "language.auto" },
  { id: "zh", labelKey: "language.zh" },
  { id: "en", labelKey: "language.en" },
];

const styles: { id: VoiceStyle; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "neutral", labelKey: "style.neutral", noteKey: "style.neutral.note" },
  { id: "calm", labelKey: "style.calm", noteKey: "style.calm.note" },
  { id: "excited", labelKey: "style.excited", noteKey: "style.excited.note" },
  { id: "gentle", labelKey: "style.gentle", noteKey: "style.gentle.note" },
];

const engines: { id: EngineFamily; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "cosyvoice2", labelKey: "engine.cosyvoice.label", noteKey: "engine.cosyvoice.note" },
  { id: "voxcpm", labelKey: "engine.voxcpm.label", noteKey: "engine.voxcpm.note" },
];

const voxcpmVersions: { id: VoxCpmVersion; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "voxcpm2", labelKey: "engine.label.voxcpm2", noteKey: "voxcpm.voxcpm2.note" },
  { id: "voxcpm1.5", labelKey: "engine.label.voxcpm1.5", noteKey: "voxcpm.voxcpm1.5.note" },
  { id: "voxcpm-0.5b", labelKey: "engine.label.voxcpm-0.5b", noteKey: "voxcpm.voxcpm-0.5b.note" },
];

function engineLabel(locale: Locale, engine: string): string {
  const item = engines.find((entry) => entry.id === engine) ?? voxcpmVersions.find((entry) => entry.id === engine);
  return item ? t(locale, item.labelKey) : engine;
}

type ActiveJob = { id: string; action: ActiveAudioJob["action"]; recordID?: string; startedAt: number; status: ShellJob["status"]; error?: string };
type SynthesisDraft = { text: string; characterId: string; style: VoiceStyle; engine: EngineFamily; voxcpmVersion: VoxCpmVersion };

const synthesisDraftStorageKey = "recut.audio-studio.synthesis-draft.v1";

function readSynthesisDraft(): SynthesisDraft {
  try {
    const draft = JSON.parse(window.sessionStorage.getItem(synthesisDraftStorageKey) || "{}") as Partial<SynthesisDraft>;
    return {
      text: typeof draft.text === "string" ? draft.text : "",
      characterId: typeof draft.characterId === "string" ? draft.characterId : "",
      style: draft.style && styles.some((item) => item.id === draft.style) ? draft.style : "neutral",
      engine: draft.engine && engines.some((item) => item.id === draft.engine) ? draft.engine : "cosyvoice2",
      voxcpmVersion: draft.voxcpmVersion && voxcpmVersions.some((item) => item.id === draft.voxcpmVersion) ? draft.voxcpmVersion : "voxcpm2",
    };
  } catch (_) { return { text: "", characterId: "", style: "neutral", engine: "cosyvoice2", voxcpmVersion: "voxcpm2" }; }
}

function saveSynthesisDraft(draft: SynthesisDraft) {
  try { window.sessionStorage.setItem(synthesisDraftStorageKey, JSON.stringify(draft)); }
  catch (_) { /* 浏览器禁止会话存储时，仍保留当前页面内的 React 状态。 */ }
}

function isTerminal(status: ShellJob["status"]) { return status !== "queued" && status !== "running"; }
function isValidActiveJob(job: ActiveAudioJob | null | undefined): job is ActiveAudioJob { return Boolean(job?.id && ["prepare", "install", "transcribe", "character", "synthesize"].includes(job.action) && ["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(job.status)); }
function logText(logs: ShellJobLog[]) { return logs.map((entry) => entry.text).join(""); }
function mergeLogs(current: ShellJobLog[], next: ShellJobLog[]) { return [...new Map([...current, ...next].map((entry) => [entry.sequence, entry])).values()].sort((left, right) => left.sequence - right.sequence).slice(-80); }
function jobStartedAt(startedAt?: string) { const value = Date.parse(startedAt || ""); return Number.isNaN(value) ? Date.now() : value; }
function formatElapsed(totalSeconds: number) { const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0"); const seconds = (totalSeconds % 60).toString().padStart(2, "0"); return `${minutes}:${seconds}`; }
function formatTimecode(seconds: number) { const milliseconds = Math.max(0, Math.round(seconds * 1000)); const hours = Math.floor(milliseconds / 3600000).toString().padStart(2, "0"); const minutes = Math.floor((milliseconds % 3600000) / 60000).toString().padStart(2, "0"); const secs = Math.floor((milliseconds % 60000) / 1000).toString().padStart(2, "0"); const millis = (milliseconds % 1000).toString().padStart(3, "0"); return `${hours}:${minutes}:${secs},${millis}`; }
function buildSRT(segments: TranscriptSegment[]) { return segments.map((segment, index) => `${index + 1}\n${formatTimecode(segment.start)} --> ${formatTimecode(segment.end)}\n${segment.text}`).join("\n\n") + "\n"; }
async function copyText(text: string) { try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; } }
function downloadBlob(name: string, content: string, mimeType: string) { const blob = new Blob([content], { type: mimeType }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function timestamp(locale: Locale, createdAt: string) { return new Date(createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US"); }
function kindLabel(locale: Locale, kind: string) { return kind === "audio" ? t(locale, "kind.audio") : kind === "video" ? t(locale, "kind.video") : kind; }
function languageLabel(locale: Locale, language: string) { return language === "auto" ? t(locale, "language.auto") : language === "zh" ? t(locale, "language.zh") : language === "en" ? t(locale, "language.en") : language; }
function styleLabel(locale: Locale, style: string) { const item = styles.find((entry) => entry.id === style); return item ? t(locale, item.labelKey) : style; }

function App() {
  const locale = useRecutLocale();
  useEffect(() => { document.documentElement.lang = locale === "zh" ? "zh-CN" : "en"; }, [locale]);
  const [initialSynthesisDraft] = useState(readSynthesisDraft);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [characters, setCharacters] = useState<VoiceCharacter[]>([]);
  const [syntheses, setSyntheses] = useState<Synthesis[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [tab, setTab] = useState<Tab>("transcribe");
  const [sourceKind, setSourceKind] = useState<"audio" | "video">("audio");
  const [assetId, setAssetId] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);
  const [model, setModel] = useState<SpeechModel>("qwen3-asr-0.6b");
  const [downloadSource, setDownloadSource] = useState<DownloadSource>("automatic");
  const [language, setLanguage] = useState<Language>("auto");
  const [characterName, setCharacterName] = useState("");
  const [characterAssetId, setCharacterAssetId] = useState("");
  const [characterAsset, setCharacterAsset] = useState<MediaAsset | null>(null);
  const [synthesisText, setSynthesisText] = useState(initialSynthesisDraft.text);
  const [synthesisCharacterId, setSynthesisCharacterId] = useState(initialSynthesisDraft.characterId);
  const [style, setStyle] = useState<VoiceStyle>(initialSynthesisDraft.style);
  const [engine, setEngine] = useState<EngineFamily>(initialSynthesisDraft.engine);
  const [voxcpmVersion, setVoxcpmVersion] = useState<VoxCpmVersion>(initialSynthesisDraft.voxcpmVersion);
  const [busy, setBusy] = useState<"prepare" | "install" | "transcribe" | "character" | "synthesize" | "save" | "upload" | "agent" | null>(null);
  const [message, setMessage] = useState(() => t(locale, "msg.starting"));
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [logs, setLogs] = useState<ShellJobLog[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [failure, setFailure] = useState("");
  // 任务中心（v2 统一任务账本）：任务结果直接在详情面板内渲染，不再二次弹框。
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskSummary | null>(null);
  const [taskLogs, setTaskLogs] = useState<TaskLogEntry[]>([]);
  const [taskFilter, setTaskFilter] = useState<"all" | "running" | "ai" | "manual">("all");
  const [launcherOpen, setLauncherOpen] = useState<Tab | null>(null);
  const [workflowStep, setWorkflowStep] = useState(0);
  const [charactersView, setCharactersView] = useState<"create" | "list" | "detail">("create");
  const [viewCharacter, setViewCharacter] = useState<VoiceCharacter | null>(null);
  const [taskResult, setTaskResult] = useState<{ kind: "transcript" | "character" | "synthesis"; item: TranscriptDetail | VoiceCharacter | Synthesis } | null>(null);
  const finalizingJob = useRef<string | null>(null);
  const logsRef = useRef<ShellJobLog[]>([]);
  const showLogsForNewJob = useCallback(() => {}, []);

  const loadTasks = useCallback(async (filter: "all" | "running" | "ai" | "manual") => {
    try {
      const result = await recut.background.call("audio.tasks.list", {
        ...(filter === "ai" ? { source: "ai" } : filter === "manual" ? { source: "manual" } : {}),
        ...(filter === "running" ? { status: "running" } : {}),
        limit: 100,
      }) as TaskListResult;
      setTasks(result.tasks);
      setSelectedTask((current) => current && result.tasks.some((item) => item.id === current.id) ? result.tasks.find((item) => item.id === current.id)! : current);
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.readTasksFailed")); }
  }, [locale]);

  const selectTask = useCallback(async (task: TaskSummary, characters: VoiceCharacter[], syntheses: Synthesis[]) => {
    setSelectedTask(task);
    try { const result = await recut.background.call("audio.task.logs", { id: task.id, limit: 300 }) as TaskLogResult; setTaskLogs(result.logs); }
    catch { setTaskLogs([]); }
    // 结果直接在详情面板内渲染（不再二次弹框）。仅当任务已完成（产出就绪）才取产物，避免「进行中」返回 {id,status,error} 无 segments。
    if (!task.recordId || task.state !== "completed") { setTaskResult(null); return; }
    try {
      if (task.action === "transcribe") {
        const detail = await recut.background.call("audio.transcript", { id: task.recordId }) as TranscriptDetail;
        setTaskResult(detail && Array.isArray(detail.segments) ? { kind: "transcript", item: detail } : null);
      } else if (task.action === "character") {
        const character = characters.find((item) => item.id === task.recordId);
        setTaskResult(character ? { kind: "character", item: character } : null);
      } else if (task.action === "synthesize") {
        const synthesis = syntheses.find((item) => item.id === task.recordId);
        setTaskResult(synthesis ? { kind: "synthesis", item: synthesis } : null);
      } else { setTaskResult(null); }
    } catch { setTaskResult(null); }
  }, [locale]);

  const cancelTaskById = async (id: string) => {
    try { await recut.background.call("audio.task.cancel", { id }); void loadTasks(taskFilter); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.stopFailed")); }
  };

  const refresh = useCallback(async (): Promise<RuntimeStatus | null> => {
    try {
      const nextStatus = await recut.state.query("audio.status") as RuntimeStatus;
      setStatus(nextStatus);
      if (nextStatus.downloadSource) setDownloadSource(nextStatus.downloadSource);
      setMessage(nextStatus.activeJob && isValidActiveJob(nextStatus.activeJob) ? t(locale, "msg.jobRunning") : nextStatus.ready ? t(locale, "msg.ready") : nextStatus.setupError ? tF(locale, "msg.setupFailed", { error: nextStatus.setupError }) : t(locale, "msg.starting"));
      try {
        const [nextCharacters, nextSyntheses] = await Promise.all([
          recut.state.query("audio.characters") as Promise<VoiceCharacter[]>,
          recut.state.query("audio.syntheses") as Promise<Synthesis[]>,
        ]);
        setCharacters(nextCharacters); setSyntheses(nextSyntheses);
      } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.readHistoryFailed")); }
      return nextStatus;
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.readStatusFailed")); }
    return null;
  }, [locale]);

  const loadAssets = useCallback(async (): Promise<MediaAsset[]> => {
    const response = await fetch("/v1/media/assets");
    if (!response.ok) throw new Error(t(locale, "msg.readLibraryFailed"));
    const next = await response.json() as MediaAsset[];
    const completed = next.filter((asset) => asset.status === "completed" && (asset.kind === "audio" || asset.kind === "video"));
    setAssets(completed); return completed;
  }, [locale]);

  const restoreJob = useCallback((job: ActiveAudioJob) => {
    if (!isValidActiveJob(job)) return;
    setLogs(job.logs);
    setElapsedSeconds(Math.floor((Date.now() - jobStartedAt(job.startedAt)) / 1000));
    setBusy(job.action as ActiveJob["action"]);
    setActiveJob({ id: job.id, action: job.action, recordID: job.recordID, startedAt: jobStartedAt(job.startedAt), status: job.status, error: job.error });
  }, []);

  const syncJob = useCallback(async () => {
    const job = await recut.state.query("audio.job") as ActiveAudioJob | null;
    if (isValidActiveJob(job)) restoreJob(job);
    else { setActiveJob(null); setBusy(null); }
  }, [restoreJob]);

  useEffect(() => { logsRef.current = logs; }, [logs]);
  useEffect(() => { saveSynthesisDraft({ text: synthesisText, characterId: synthesisCharacterId, style, engine, voxcpmVersion }); }, [engine, style, synthesisCharacterId, synthesisText, voxcpmVersion]);
  useEffect(() => { window.addEventListener("recut-sdk-ready", refresh); void refresh(); return () => window.removeEventListener("recut-sdk-ready", refresh); }, [refresh]);
  useEffect(() => { void loadAssets().catch((error) => setMessage(error.message)); }, [loadAssets]);
  useEffect(() => { if (isValidActiveJob(status?.activeJob)) restoreJob(status.activeJob); }, [restoreJob, status?.activeJob]);
  useEffect(() => {
    if (!activeJob) return;
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - activeJob.startedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [activeJob]);
  useEffect(() => {
    if (!activeJob || isTerminal(activeJob.status)) return;
    const timer = window.setInterval(() => { void syncJob().catch((error) => setMessage(error instanceof Error ? error.message : t(locale, "msg.syncJobFailed"))); }, 1000);
    return () => window.clearInterval(timer);
  }, [activeJob, syncJob, locale]);
  useEffect(() => recut.events.subscribe((raw) => {
    const event = raw as { type?: string; log?: ShellJobLog; job?: ShellJob };
    if (event.type === "shell.job.log" && event.log?.jobId === activeJob?.id) setLogs((items) => mergeLogs(items, [event.log as ShellJobLog]));
    if (event.type !== "shell.job.completed" || event.job?.id !== activeJob?.id) return;
    setActiveJob((current) => current && current.id === event.job?.id ? { ...current, status: event.job.status, error: event.job.error } : current);
  }), [activeJob]);

  // 任务从「进行中」落到「已完成」时，自动加载其执行结果（不再需要手动重新点击）。
  useEffect(() => {
    if (selectedTask && selectedTask.state === "completed") void selectTask(selectedTask, characters, syntheses);
  }, [selectedTask?.id, selectedTask?.state, selectTask, characters, syntheses]);

  useEffect(() => { void loadTasks(taskFilter); }, [loadTasks, taskFilter]);
  useEffect(() => {
    if (!selectedTask || isTerminal(selectedTask.state as ShellJob["status"])) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const result = await recut.background.call("audio.task.logs", { id: selectedTask.id, limit: 300 }) as TaskLogResult;
          setTaskLogs(result.logs);
          await loadTasks(taskFilter);
        } catch { /* 轮询失败忽略，等待下次间隔 */ }
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [selectedTask, loadTasks, taskFilter]);

  const finishJob = useCallback(async (job: ActiveJob) => {
    if (finalizingJob.current === job.id) return;
    finalizingJob.current = job.id;
    try {
      if (job.status !== "completed") {
        const tail = [...logsRef.current].reverse().map((entry) => entry.text.trim()).find(Boolean);
        const error = tail || job.error || t(locale, "msg.taskIncomplete");
        setFailure(error); setMessage(error);
      } else if (job.action === "transcribe" && job.recordID) {
        await recut.background.call("audio.transcript", { id: job.recordID });
        setMessage(t(locale, "msg.transcribeDone"));
      } else if (job.action === "character" && job.recordID) {
        await recut.background.call("audio.character.complete", { id: job.recordID });
        setMessage(t(locale, "msg.characterCreated"));
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
      setBusy(null); setActiveJob((current) => current?.id === job.id ? null : current); finalizingJob.current = null;
      void refresh();
    }
  }, [refresh, locale]);
  useEffect(() => { if (activeJob && isTerminal(activeJob.status)) void finishJob(activeJob); }, [activeJob, finishJob]);

  const compatibleAssets = useMemo(() => assets.filter((asset) => asset.kind === "audio" || asset.kind === "video"), [assets]);
  const sourceAsset = selectedAsset?.id === assetId ? selectedAsset : compatibleAssets.find((asset) => asset.id === assetId) ?? null;
  const readySpeechModel = Boolean(status?.asr?.installed?.includes(model));
  const ttsReady = Boolean(status?.tts?.ready);
  const voxcpmEngine = status?.tts?.engines?.voxcpm ?? null;
  const voxcpmModel = voxcpmEngine?.models[voxcpmVersion] ?? null;
  const effectiveEngine: TtsEngine = engine === "cosyvoice2" ? "cosyvoice2" : voxcpmVersion;
  const engineReady = engine === "cosyvoice2" ? ttsReady : Boolean(voxcpmModel?.ready);
  const engineNeedsCharacter = engine === "voxcpm" && voxcpmVersion !== "voxcpm2";
  const running = busy === "prepare" || busy === "install" || busy === "transcribe" || busy === "character" || busy === "synthesize";

  const beginJob = (job: ShellJob, action: ActiveJob["action"], recordID?: string) => {
    setElapsedSeconds(0);
    setActiveJob({ id: job.id, action, recordID, startedAt: jobStartedAt(job.startedAt), status: job.status, error: job.error });
    void loadTasks(taskFilter);
    void syncJob().catch((error) => setMessage(error instanceof Error ? error.message : t(locale, "msg.jobLogFailed")));
  };

  const installSpeechModel = async () => {
    setBusy("install"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(tF(locale, "msg.downloadingModel", { name: speechModels.find((item) => item.id === model)?.label ?? model }));
    try { const result = await recut.background.call("audio.install", { model, source: downloadSource }) as { job: ShellJob; taskId: string }; beginJob(result.job, "install"); focusNewTask(result.taskId, "install", "", { type: "ASR 模型", model }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
  };

  const installCosyVoice = async () => {
    setBusy("install"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.downloadingCosyVoice"));
    try { const result = await recut.background.call("audio.install", { model: "cosyvoice2", source: downloadSource }) as { job: ShellJob; taskId: string }; beginJob(result.job, "install"); focusNewTask(result.taskId, "install", "", { type: "TTS 模型", model: "cosyvoice2" }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
  };

  const installVoxCpm = async (version: VoxCpmVersion) => {
    const model = voxcpmEngine?.models[version] ?? null;
    const label = model?.label ?? version;
    const sizeGb = model?.sizeGb ?? 0;
    setBusy("install"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(tF(locale, "msg.downloadingVoxCpm", { label, size: sizeGb.toFixed(1) }));
    try { const result = await recut.background.call("audio.install", { model: version, source: downloadSource }) as { job: ShellJob; taskId: string }; beginJob(result.job, "install"); focusNewTask(result.taskId, "install", "", { type: "TTS 模型", model: version, sizeGb }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
  };

  const retryVoxCpmRuntime = async () => {
    setBusy("prepare"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.voxcpmRuntimeInstalling"));
    try { const result = await recut.background.call("audio.prepare") as { job: ShellJob; taskId: string }; beginJob(result.job, "prepare"); focusNewTask(result.taskId, "prepare", "", { type: "运行环境" }); }
    catch (error) { const message = error instanceof Error ? error.message : t(locale, "msg.startFailed"); setFailure(message); setMessage(message); setBusy(null); }
  };

  const prepare = useCallback(async () => {
    setBusy("prepare"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.starting"));
    try { const result = await recut.background.call("audio.prepare") as { job: ShellJob }; beginJob(result.job, "prepare"); }
    catch (error) { const message = error instanceof Error ? error.message : t(locale, "msg.startFailed"); setFailure(message); setMessage(message); setBusy(null); }
  }, [locale]);

  const focusNewTask = useCallback((taskId: string, action: TaskAction, recordId: string, meta: TaskSummary["meta"]) => {
    setLauncherOpen(null);
    const placeholder: TaskSummary = { id: taskId, action, name: "", recordId, source: "manual", submittedBy: "", state: "running", progress: 0, createdAt: new Date().toISOString(), meta };
    setSelectedTask(placeholder);
    void selectTask(placeholder, characters, syntheses);
  }, [characters, syntheses, selectTask]);

  const transcribeSource = async () => {
    if (!assetId) return setMessage(t(locale, "msg.pickSourceFirst"));
    setBusy("transcribe"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(sourceKind === "video" ? t(locale, "msg.extractingVideo") : t(locale, "msg.transcribing"));
    try { const result = await recut.background.call("audio.transcribe", { assetId, kind: sourceKind, model, language }) as { job: ShellJob; taskId: string; transcript: { id: string } }; beginJob(result.job, "transcribe", result.transcript.id); focusNewTask(result.taskId, "transcribe", result.transcript.id, { type: "转写", model, language, sourceAssetId: assetId, sourceKind }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.transcribeFailed")); setBusy(null); }
  };

  const createCharacter = async () => {
    if (!characterAssetId) return setMessage(t(locale, "msg.pickReferenceFirst"));
    if (!characterName.trim()) return setMessage(t(locale, "msg.nameCharacter"));
    setBusy("character"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.creatingCharacter"));
    try { const result = await recut.background.call("audio.character.create", { assetId: characterAssetId, name: characterName.trim(), model }) as { job: ShellJob; taskId: string; character: { id: string } }; beginJob(result.job, "character", result.character.id); focusNewTask(result.taskId, "character", result.character.id, { type: "声音角色", model, characterName: characterName.trim(), sourceAssetId: characterAssetId }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.characterFailed")); setBusy(null); }
  };

  const synthesizeVoice = async () => {
    if (!synthesisText.trim()) return setMessage(t(locale, "msg.enterText"));
    if (engineNeedsCharacter && !synthesisCharacterId) return setMessage(t(locale, "msg.pickReferenceForVoxCpm"));
    saveSynthesisDraft({ text: synthesisText, characterId: synthesisCharacterId, style, engine, voxcpmVersion });
    setBusy("synthesize"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.synthesizing"));
    try { const result = await recut.background.call("audio.synthesize", { ...(synthesisCharacterId ? { characterId: synthesisCharacterId } : {}), text: synthesisText, style, engine: effectiveEngine }) as { job: ShellJob; taskId: string; synthesis: { id: string } }; beginJob(result.job, "synthesize", result.synthesis.id); focusNewTask(result.taskId, "synthesize", result.synthesis.id, { type: "配音合成", engine: effectiveEngine, characterId: synthesisCharacterId }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.synthesisFailed")); setBusy(null); }
  };

  const chooseSource = async (kinds: string[]) => {
    try {
      const selected = await recut.media.pick(kinds) as MediaAsset | null;
      if (!selected) return;
      setAssets((items) => items.some((asset) => asset.id === selected.id) ? items : [selected, ...items]);
      setSelectedAsset(selected); setAssetId(selected.id); setSourceKind(selected.kind === "video" ? "video" : "audio"); setMessage(tF(locale, "msg.pickedSource", { kind: kindLabel(locale, selected.kind), name: selected.name }));
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.pickerFailed")); }
  };

  const chooseCharacterSource = async () => {
    try {
      const selected = await recut.media.pick(["audio"]) as MediaAsset | null;
      if (!selected) return;
      setAssets((items) => items.some((asset) => asset.id === selected.id) ? items : [selected, ...items]);
      setCharacterAsset(selected); setCharacterAssetId(selected.id); setMessage(tF(locale, "msg.pickedReference", { name: selected.name }));
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.pickerFailed")); }
  };

  const upload = async (file: File | undefined, kind: "source" | "character") => {
    if (!file) return;
    if (!/^(audio|video)\//.test(file.type)) return setMessage(t(locale, "msg.uploadAudioOnly"));
    setBusy("upload");
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/v1/media/assets", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok || !payload.id) throw new Error(payload.error || t(locale, "msg.uploadFailed"));
      const nextAssets = await loadAssets();
      const selected = nextAssets.find((asset) => asset.id === payload.id) ?? { id: payload.id, name: file.name, kind: "audio", mimeType: file.type, status: "completed" };
      if (kind === "character") { setCharacterAsset(selected); setCharacterAssetId(payload.id); }
      else { setSelectedAsset(selected); setAssetId(payload.id); setSourceKind(selected.kind === "video" ? "video" : "audio"); }
      setMessage(t(locale, "msg.uploadedSelected"));
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.uploadFailed")); }
    finally { setBusy(null); }
  };

  const saveTranscript = async (transcript: Pick<TranscriptSummary, "id">) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: transcript.id, kind: "transcript" }) as { assetId: string }; setTaskResult((current) => current?.kind === "transcript" && current.item.id === transcript.id ? { kind: "transcript", item: { ...(current.item as TranscriptDetail), savedAssetId: result.assetId } } : current); setMessage(t(locale, "msg.transcriptSaved")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
    finally { setBusy(null); }
  };

  const saveSynthesis = async (synthesis: Synthesis) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: synthesis.id, kind: "synthesis" }) as { assetId: string }; setSyntheses((items) => items.map((item) => item.id === synthesis.id ? { ...item, savedAssetId: result.assetId } : item)); setTaskResult((current) => current?.kind === "synthesis" && current.item.id === synthesis.id ? { kind: "synthesis", item: { ...(current.item as Synthesis), savedAssetId: result.assetId } } : current); setMessage(t(locale, "msg.synthesisSaved")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
    finally { setBusy(null); }
  };

  const saveCharacter = async (character: VoiceCharacter) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: character.id, kind: "character" }) as { assetId: string }; setCharacters((items) => items.map((item) => item.id === character.id ? { ...item, sampleAssetId: result.assetId } : item)); setTaskResult((current) => current?.kind === "character" && current.item.id === character.id ? { kind: "character", item: { ...(current.item as VoiceCharacter), sampleAssetId: result.assetId } } : current); setMessage(t(locale, "msg.characterSampleSaved")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
    finally { setBusy(null); }
  };

  const askAgent = async () => {
    setBusy("agent");
    const details = (status?.setupLogs ?? []).map((entry) => entry.text).join("").slice(-2000);
    const context = status?.setupError || status?.error || message;
    const pythonHint = status?.pythonVersion ? tF(locale, "agent.pythonHint", { version: status.pythonVersion }) : "";
    try { await recut.agent.compose(tF(locale, "agent.prompt", { error: context, pythonHint, logs: details || t(locale, "agent.noLogs") })); setMessage(t(locale, "msg.agentDiagnosisFilled")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.agentDiagnosisFailed")); }
    finally { setBusy(null); }
  };

  const updateSegmentText = (index: number, text: string) => {
    setTaskResult((current) => {
      if (current?.kind !== "transcript") return current;
      const transcript = current.item as TranscriptDetail;
      return { kind: "transcript", item: { ...transcript, segments: transcript.segments.map((segment, cursor) => cursor === index ? { ...segment, text } : segment) } };
    });
  };

  if (!status?.ready) return <Setup autoPrepare={status !== null} busy={busy} elapsedSeconds={elapsedSeconds} failure={status?.setupError || failure || (!status?.pending ? status?.error || "" : "")} failureLogs={status?.setupLogs ?? []} logs={logs} message={message} pythonVersion={status?.pythonVersion} onPrepare={() => void prepare()} onAskAgent={() => void askAgent()} />;

  const nav = { step: workflowStep, onBack: () => setWorkflowStep((current) => Math.max(0, current - 1)), onNext: () => setWorkflowStep((current) => current + 1) };
  const controls = <div className="flex flex-col gap-6">
    {tab === "transcribe" && <TranscribeControls {...nav} busy={busy} downloadSource={downloadSource} language={language} model={model} readySpeechModel={readySpeechModel} setDownloadSource={setDownloadSource} setLanguage={setLanguage} setModel={setModel} sourceAsset={sourceAsset} upload={(file) => void upload(file, "source")} onChoose={() => void chooseSource(["audio", "video"])} onRun={() => void transcribeSource()} onInstall={() => void installSpeechModel()} />}
    {tab === "characters" && <CharacterControls {...nav} busy={busy} characterAsset={characterAsset} characterName={characterName} downloadSource={downloadSource} model={model} readySpeechModel={readySpeechModel} setDownloadSource={setDownloadSource} setCharacterName={setCharacterName} setModel={setModel} upload={(file) => void upload(file, "character")} onChoose={() => void chooseCharacterSource()} onRun={() => void createCharacter()} onInstall={() => void installSpeechModel()} />}
    {tab === "synthesize" && <SynthesizeControls {...nav} busy={busy} characters={characters} downloadSource={downloadSource} engine={engine} engineNeedsCharacter={engineNeedsCharacter} engineReady={engineReady} setDownloadSource={setDownloadSource} setEngine={setEngine} setSynthesisCharacterId={setSynthesisCharacterId} setSynthesisText={setSynthesisText} setStyle={setStyle} setVoxcpmVersion={setVoxcpmVersion} style={style} synthesisCharacterId={synthesisCharacterId} synthesisText={synthesisText} voxcpmEngine={voxcpmEngine} voxcpmVersion={voxcpmVersion} onInstall={() => void installCosyVoice()} onInstallVoxCpm={(version) => void installVoxCpm(version)} onRetryVoxCpmRuntime={() => void retryVoxCpmRuntime()} onRun={() => void synthesizeVoice()} />}
  </div>;

  return <div className="mx-auto flex h-dvh w-full max-w-[1440px] flex-col overflow-hidden p-6">
    <header className="flex shrink-0 flex-col gap-0.5 border-b pb-4">
      <h1 className="text-xl font-semibold tracking-tight">{t(locale, "app.title")}</h1>
      <p className="text-sm text-muted-foreground">{t(locale, "app.subtitle")}</p>
    </header>
    <LauncherBar onLaunch={(next) => { setTab(next); setLauncherOpen(next); setWorkflowStep(0); if (next === "characters") { setCharactersView("create"); setViewCharacter(null); } }} running={running} />
    <main className="mt-4 grid min-h-0 flex-1 items-stretch gap-4 min-[900px]:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
      <TaskCenter tasks={tasks} filter={taskFilter} selectedTask={selectedTask} onCancelTask={(id) => void cancelTaskById(id)} onFilter={setTaskFilter} onSelect={(task) => { void selectTask(task, characters, syntheses); }} />
      <TaskDetail busy={busy} logs={taskLogs} selectedTask={selectedTask} result={taskResult} onEditSegment={updateSegmentText} onSaveCharacter={(character) => void saveCharacter(character)} onSaveSynthesis={(synthesis) => void saveSynthesis(synthesis)} onSaveTranscript={(transcript) => void saveTranscript(transcript)} />
    </main>
    {launcherOpen === "characters" ? (
      <DialogCard title={t(locale, "nav.characters.label")} onClose={() => setLauncherOpen(null)} headerAction={charactersView === "create" ? <Button onClick={() => { setCharactersView("list"); setViewCharacter(null); }} size="sm" type="button" variant="outline">{tF(locale, "characters.all", { count: characters.length })}</Button> : <Button onClick={() => { setCharactersView("create"); setViewCharacter(null); }} size="sm" type="button" variant="outline">{t(locale, "characters.new")}</Button>}>
        {charactersView === "create" ? <div className="flex flex-col">{controls}</div>
          : charactersView === "detail" && viewCharacter ? <div className="grid gap-3"><Button className="w-fit" onClick={() => { setCharactersView("list"); setViewCharacter(null); }} size="sm" type="button" variant="ghost">{t(locale, "characters.back")}</Button><CharacterPreview busy={busy} character={viewCharacter} onSave={() => void saveCharacter(viewCharacter)} /></div>
          : <CharList characters={characters} onOpen={(character) => { setViewCharacter(character); setCharactersView("detail"); }} />}
      </DialogCard>
    ) : launcherOpen ? (
      <DialogCard title={t(locale, launcherOpen === "transcribe" ? "nav.transcribe.label" : "nav.synthesize.label")} onClose={() => setLauncherOpen(null)}>{controls}</DialogCard>
    ) : null}
  </div>;
}

function DialogCard({ title, onClose, children, headerAction }: { title: string; onClose: () => void; children: ReactNode; headerAction?: ReactNode }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
    <div className="w-full max-w-2xl overflow-hidden rounded-xl border bg-card shadow-xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between gap-2 border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-2">{headerAction}<Button aria-label="close" onClick={onClose} type="button" variant="ghost" size="icon"><X className="size-4" /></Button></div>
      </div>
      <div className="p-5">{children}</div>
    </div>
  </div>;
}

function CharList({ characters, onOpen }: { characters: VoiceCharacter[]; onOpen: (character: VoiceCharacter) => void }) {
  const locale = useRecutLocale();
  return <div className="grid gap-3 min-[560px]:grid-cols-2">
    {characters.length ? characters.map((character) => <button className="group grid gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:border-ring hover:bg-muted" key={character.id} onClick={() => onOpen(character)} type="button"><span className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-sm font-semibold">{character.name}</span>{character.sampleAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</span><span className="text-[11px] text-muted-foreground">{character.model.replace("whisper-", "")} · {timestamp(locale, character.createdAt)}</span></button>) : <p className="col-span-full py-8 text-center text-sm text-muted-foreground">{t(locale, "characters.empty")}</p>}
  </div>;
}

function LauncherBar({ onLaunch, running }: { onLaunch: (tab: Tab) => void; running: boolean }) {
  const locale = useRecutLocale();
  const launchers: { id: Tab; icon: ReactNode; labelKey: I18nKey; noteKey: I18nKey; primary: boolean }[] = [
    { id: "transcribe", icon: <MessageSquareText className="size-6" />, labelKey: "nav.transcribe.label", noteKey: "nav.transcribe.note", primary: true },
    { id: "characters", icon: <Mic className="size-6" />, labelKey: "nav.characters.label", noteKey: "nav.characters.note", primary: false },
    { id: "synthesize", icon: <Sparkles className="size-6" />, labelKey: "nav.synthesize.label", noteKey: "nav.synthesize.note", primary: false },
  ];
  return <div className="mt-4 flex shrink-0 items-center gap-3 border-b pb-5">
    {launchers.map((item) => (
      <button className={cn("group flex min-w-0 flex-1 items-center gap-3 rounded-lg border px-4 py-4 text-left transition-colors hover:border-ring", item.primary ? "border-primary/60 bg-accent/50 hover:bg-accent/70" : "bg-card hover:bg-muted")} key={item.id} onClick={() => onLaunch(item.id)} type="button">
        <span className={cn("grid size-12 shrink-0 place-items-center rounded-lg", item.primary ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")}>{item.icon}</span>
        <span className="grid min-w-0 gap-1">
          <span className="truncate text-base font-semibold">{t(locale, item.labelKey)}</span>
          <span className="truncate text-xs text-muted-foreground">{t(locale, item.noteKey)}</span>
        </span>
      </button>
    ))}
    <div className="ml-2 shrink-0">{running ? <Badge variant="secondary" className="font-mono"><Clock3 className="size-3.5" />{t(locale, "msg.jobRunning")}</Badge> : null}</div>
  </div>;
}

function taskStateLabel(locale: Locale, state: TaskState): string {
  if (state === "running") return t(locale, "task.state.running");
  if (state === "queued") return t(locale, "task.state.queued");
  if (state === "completed") return t(locale, "task.state.done");
  if (state === "failed") return t(locale, "task.state.failed");
  if (state === "cancelled") return t(locale, "task.state.cancelled");
  return t(locale, "task.state.interrupted");
}

function TaskCenter({ tasks, filter, selectedTask, onFilter, onSelect, onCancelTask }: { tasks: TaskSummary[]; filter: "all" | "running" | "ai" | "manual"; selectedTask: TaskSummary | null; onFilter: (filter: "all" | "running" | "ai" | "manual") => void; onSelect: (task: TaskSummary) => void; onCancelTask: (id: string) => void }) {
  const locale = useRecutLocale();
  const groups = new Map<string, TaskSummary[]>();
  tasks.forEach((task) => { const date = task.createdAt.slice(0, 10); groups.set(date, [...(groups.get(date) ?? []), task]); });
  const filters: { id: "all" | "running" | "ai" | "manual"; labelKey: I18nKey }[] = [
    { id: "all", labelKey: "task.filter.all" },
    { id: "running", labelKey: "task.filter.running" },
    { id: "ai", labelKey: "task.filter.ai" },
    { id: "manual", labelKey: "task.filter.manual" },
  ];
  return <Card className="flex h-full min-h-0 flex-col rounded-lg shadow-none">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
      <h2 className="text-sm font-semibold">{t(locale, "task.listTitle")}</h2>
      <div className="flex gap-1 rounded-md border bg-muted/50 p-1">{filters.map((item) => <Button className={cn(filter === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} key={item.id} onClick={() => onFilter(item.id)} size="sm" type="button" variant="ghost">{t(locale, item.labelKey)}</Button>)}</div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {tasks.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t(locale, "task.empty")}</p>}
      {[...groups.entries()].map(([date, items]) => <div key={date}>
        <p className="px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{date}</p>
        {items.map((task) => <TaskRow key={task.id} onCancel={onCancelTask} onSelect={onSelect} selected={selectedTask?.id === task.id} task={task} />)}
      </div>)}
    </div>
  </Card>;
}

function TaskRow({ task, selected, onSelect, onCancel }: { task: TaskSummary; selected: boolean; onSelect: (task: TaskSummary) => void; onCancel: (id: string) => void }) {
  const locale = useRecutLocale();
  const active = task.state === "running" || task.state === "queued";
  const failed = task.state === "failed";
  return <button className={cn("mb-1 w-full rounded-md border px-3 py-2.5 text-left transition-colors", selected ? "border-primary bg-accent/50" : "border-transparent hover:bg-muted")} onClick={() => onSelect(task)} type="button">
    <div className="flex items-center gap-2">
      <span className="grid size-2 shrink-0 place-items-center"><span className={cn("size-2 rounded-full", active ? "bg-primary" : failed ? "bg-destructive" : task.state === "completed" ? "bg-success" : "bg-muted-foreground/50")} /></span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.name}</span>
    </div>
    <div className="mt-1.5 flex items-center gap-2">
      <Badge variant="secondary" className={cn("font-mono", task.source === "ai" && "border-primary/40 text-primary")}>{task.source === "ai" ? t(locale, "task.source.ai") : t(locale, "task.source.manual")}</Badge>
      <span className="text-[11px] text-muted-foreground">{taskStateLabel(locale, task.state)}</span>
      <span className="flex-1" />
      {task.submittedBy && <span className="truncate text-[11px] text-muted-foreground">{task.submittedBy}</span>}
      {active && <Button onClick={(event) => { event.stopPropagation(); onCancel(task.id); }} size="sm" type="button" variant="ghost"><CircleStop className="size-3.5" /></Button>}
    </div>
  </button>;
}

function TaskDetail({ busy, selectedTask, logs, result, onEditSegment, onSaveCharacter, onSaveTranscript, onSaveSynthesis }: { busy: string | null; selectedTask: TaskSummary | null; logs: TaskLogEntry[]; result: { kind: "transcript" | "character" | "synthesis"; item: TranscriptDetail | VoiceCharacter | Synthesis } | null; onEditSegment: (index: number, text: string) => void; onSaveCharacter: (character: VoiceCharacter) => void; onSaveTranscript: (transcript: TranscriptDetail) => void; onSaveSynthesis: (synthesis: Synthesis) => void }) {
  const locale = useRecutLocale();
  if (!selectedTask) return <Card className="grid h-full min-h-0 place-items-center rounded-lg shadow-none"><p className="px-4 text-center text-sm text-muted-foreground">{t(locale, "task.detailEmpty")}</p></Card>;
  return <div className="grid h-full min-h-0 content-start gap-4 overflow-y-auto pr-1">
    <Card className="rounded-lg shadow-none">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3.5">
        <div><h2 className="text-base font-semibold">{selectedTask.name}</h2><p className="mt-0.5 text-xs text-muted-foreground">{taskStateLabel(locale, selectedTask.state)} · {new Date(selectedTask.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</p></div>
        <Badge variant="secondary" className="font-mono">{selectedTask.source === "ai" ? t(locale, "task.source.ai") : t(locale, "task.source.manual")}</Badge>
      </div>
      <div className="grid gap-3 p-4">
        <div>
          <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t(locale, "task.logsTitle")}</p>
          <pre className="max-h-64 overflow-auto rounded-md bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg">{logs.length ? logs.map((entry) => `${entry.ts ? "[" + entry.ts + "] " : ""}${entry.message}`).join("\n") : t(locale, "task.logsEmpty")}</pre>
        </div>
      </div>
    </Card>
    {result && <Card className="rounded-lg shadow-none">
      <div className="border-b px-4 py-2.5"><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t(locale, "task.resultTitle")}</p></div>
      {result.kind === "transcript" ? <TranscriptOutput busy={busy} onEditSegment={onEditSegment} onSave={onSaveTranscript} transcript={result.item as TranscriptDetail} />
        : result.kind === "character" ? <div className="p-3"><CharacterPreview busy={busy} character={result.item as VoiceCharacter} onSave={() => onSaveCharacter(result.item as VoiceCharacter)} /></div>
        : <SynthesisOutput busy={busy} onSave={onSaveSynthesis} selected={result.item as Synthesis} syntheses={[result.item as Synthesis]} />}
    </Card>}
  </div>;
}

function StepFooter({ step, total, busy, onBack, onNext, onFinish, finishDisabled, finishLabel }: { step: number; total: number; busy: string | null; onBack: () => void; onNext: () => void; onFinish: () => void; finishDisabled: boolean; finishLabel: ReactNode }) {
  const locale = useRecutLocale();
  const disabled = busy !== null;
  return <div className="flex items-center justify-between gap-3 border-t pt-4">
    <div className="flex gap-1.5">{Array.from({ length: total }).map((_, index) => <span className={cn("h-1.5 w-6 rounded-full", index <= step ? "bg-primary" : "bg-muted")} key={index} />)}</div>
    <div className="flex items-center gap-2">
      {step > 0 && <Button className="min-w-20" disabled={disabled} onClick={onBack} type="button" variant="ghost">{t(locale, "stepper.back")}</Button>}
      {step < total - 1
        ? <Button className="min-w-24" disabled={disabled} onClick={onNext} type="button">{t(locale, "stepper.next")}</Button>
        : <Button className="min-w-32" disabled={disabled || finishDisabled} onClick={onFinish} type="button" size="lg">{finishLabel}</Button>}
    </div>
  </div>;
}

function ControlSection({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return <section className="grid gap-3"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p><h2 className="mt-0.5 text-sm font-semibold">{title}</h2></div>{children}</section>;
}

function ModelSelect({ disabled, model, onChange }: { disabled: boolean; model: SpeechModel; onChange: (value: SpeechModel) => void }) {
  const locale = useRecutLocale();
  return <div className="grid gap-2">
    <Label htmlFor="speech-model" className="text-xs text-muted-foreground">{t(locale, "modelSelect.label")}</Label>
    <Select disabled={disabled} onValueChange={(value) => onChange(value as SpeechModel)} value={model}>
      <SelectTrigger id="speech-model" className="h-9 w-full min-w-0"><SelectValue placeholder={t(locale, "modelSelect.placeholder")} /></SelectTrigger>
      <SelectContent>{speechModels.map((item) => <SelectItem key={item.id} value={item.id}>{item.label} · {t(locale, item.noteKey)}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

function DownloadSourceSelect({ disabled, source, onChange }: { disabled: boolean; source: DownloadSource; onChange: (value: DownloadSource) => void }) {
  const locale = useRecutLocale();
  const selected = downloadSources.find((item) => item.id === source);
  return <div className="grid gap-2">
    <Label htmlFor="download-source" className="text-xs text-muted-foreground">{t(locale, "downloadSource.label")}</Label>
    <Select disabled={disabled} onValueChange={(value) => onChange(value as DownloadSource)} value={source}>
      <SelectTrigger id="download-source" className="h-9 w-full min-w-0"><SelectValue placeholder={t(locale, "downloadSource.placeholder")} /></SelectTrigger>
      <SelectContent>{downloadSources.map((item) => <SelectItem key={item.id} value={item.id}>{t(locale, item.labelKey)}</SelectItem>)}</SelectContent>
    </Select>
    {selected && <p className="text-[11px] leading-relaxed text-muted-foreground">{t(locale, selected.noteKey)}</p>}
  </div>;
}

function SourceButtons({ busy, onChoose, selectedLabel, onUpload, media }: { busy: boolean; onChoose: () => void; selectedLabel: string; onUpload: (file: File | undefined) => void; media?: boolean }) {
  const locale = useRecutLocale();
  const accept = media ? "audio/*,video/*" : "audio/*";
  return <div className="grid gap-2">
    <Label className="text-xs text-muted-foreground">{t(locale, "library.label")}</Label>
    <Button disabled={busy} onClick={onChoose} type="button" variant="outline"><FolderOpen className="size-3.5" />{selectedLabel}</Button>
    <Label className="relative inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium shadow-xs transition-colors hover:bg-input/50 disabled:pointer-events-none disabled:opacity-50"><Upload className="size-3.5" />{media ? t(locale, "upload.media") : t(locale, "upload.audio")}<input accept={accept} className="sr-only" disabled={busy} onChange={(event) => onUpload(event.target.files?.[0])} type="file" /></Label>
  </div>;
}

function TranscribeControls({ busy, downloadSource, language, model, readySpeechModel, setDownloadSource, setLanguage, setModel, sourceAsset, upload, onChoose, onRun, onInstall, step, onBack, onNext }: { busy: string | null; downloadSource: DownloadSource; language: Language; model: SpeechModel; readySpeechModel: boolean; setDownloadSource: (value: DownloadSource) => void; setLanguage: (value: Language) => void; setModel: (value: SpeechModel) => void; sourceAsset: MediaAsset | null; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onInstall: () => void; step: number; onBack: () => void; onNext: () => void }) {
  const locale = useRecutLocale();
  const total = 3;
  return <div className="flex flex-col gap-6">
    {step === 0 && <ControlSection eyebrow={t(locale, "controls.input.eyebrow")} title={t(locale, "controls.input.sourceTitle")}>
      <SourceButtons busy={busy !== null} media onChoose={onChoose} onUpload={upload} selectedLabel={sourceAsset ? t(locale, "source.change") : t(locale, "source.pick.media")} />
      {sourceAsset && <SelectedSource asset={sourceAsset} />}
    </ControlSection>}
    {step === 1 && <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.model.weightsTitle")}>
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "downloaded")}</p> : <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />{t(locale, "download.model")}</Button>}
    </ControlSection>}
    {step === 2 && <ControlSection eyebrow={t(locale, "controls.language.eyebrow")} title={t(locale, "controls.language.title")}>
      <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/50 p-1">{languages.map((item) => <Button className={cn(language === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setLanguage(item.id)} type="button" variant="ghost" size="sm">{t(locale, item.labelKey)}</Button>)}</div>
    </ControlSection>}
    <StepFooter busy={busy} finishDisabled={busy !== null || !sourceAsset || !readySpeechModel} finishLabel={busy === "transcribe" ? <><LoaderCircle className="size-4 animate-spin" />{t(locale, "nav.transcribe.label")}</> : <><MessageSquareText className="size-4" />{t(locale, "nav.transcribe.label")}</>} onBack={onBack} onFinish={onRun} onNext={onNext} step={step} total={total} />
  </div>;
}

function CharacterControls({ busy, characterAsset, characterName, downloadSource, model, readySpeechModel, setDownloadSource, setCharacterName, setModel, upload, onChoose, onRun, onInstall, step, onBack, onNext }: { busy: string | null; characterAsset: MediaAsset | null; characterName: string; downloadSource: DownloadSource; model: SpeechModel; readySpeechModel: boolean; setDownloadSource: (value: DownloadSource) => void; setCharacterName: (value: string) => void; setModel: (value: SpeechModel) => void; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onInstall: () => void; step: number; onBack: () => void; onNext: () => void }) {
  const locale = useRecutLocale();
  const total = 2;
  return <div className="flex flex-col gap-6">
    {step === 0 && <ControlSection eyebrow={t(locale, "controls.input.eyebrow")} title={t(locale, "controls.character.title")}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t(locale, "controls.character.desc")}</p>
      <SourceButtons busy={busy !== null} onChoose={onChoose} onUpload={upload} selectedLabel={characterAsset ? t(locale, "source.character.change") : t(locale, "source.character.pick")} />
      {characterAsset && <SelectedSource asset={characterAsset} />}
      <div className="grid gap-2">
        <Label htmlFor="character-name" className="text-xs text-muted-foreground">{t(locale, "character.name.label")}</Label>
        <Input disabled={busy !== null} id="character-name" onChange={(event) => setCharacterName(event.target.value)} placeholder={t(locale, "character.name.placeholder")} value={characterName} />
      </div>
    </ControlSection>}
    {step === 1 && <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.character.promptModelTitle")}>
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "downloaded")}</p> : <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />{t(locale, "download.model")}</Button>}
    </ControlSection>}
    <StepFooter busy={busy} finishDisabled={busy !== null || !characterAsset || !characterName.trim() || !readySpeechModel} finishLabel={busy === "character" ? <><LoaderCircle className="size-4 animate-spin" />{t(locale, "controls.character.title")}</> : <><Mic className="size-4" />{t(locale, "controls.character.title")}</>} onBack={onBack} onFinish={onRun} onNext={onNext} step={step} total={total} />
  </div>;
}

function SynthesizeControls({ busy, characters, downloadSource, engine, engineNeedsCharacter, engineReady, setDownloadSource, setEngine, setSynthesisCharacterId, setSynthesisText, setStyle, setVoxcpmVersion, style, synthesisCharacterId, synthesisText, voxcpmEngine, voxcpmVersion, onInstall, onInstallVoxCpm, onRetryVoxCpmRuntime, onRun, step, onBack, onNext }: { busy: string | null; characters: VoiceCharacter[]; downloadSource: DownloadSource; engine: EngineFamily; engineNeedsCharacter: boolean; engineReady: boolean; setDownloadSource: (value: DownloadSource) => void; setEngine: (value: EngineFamily) => void; setSynthesisCharacterId: (value: string) => void; setSynthesisText: (value: string) => void; setStyle: (value: VoiceStyle) => void; setVoxcpmVersion: (value: VoxCpmVersion) => void; style: VoiceStyle; synthesisCharacterId: string; synthesisText: string; voxcpmEngine: VoxCpmEngineStatus | null; voxcpmVersion: VoxCpmVersion; onInstall: () => void; onInstallVoxCpm: (version: VoxCpmVersion) => void; onRetryVoxCpmRuntime: () => void; onRun: () => void; step: number; onBack: () => void; onNext: () => void }) {
  const locale = useRecutLocale();
  const isVoxCpm = engine !== "cosyvoice2";
  const selectedVersion = voxcpmVersions.find((item) => item.id === voxcpmVersion) ?? voxcpmVersions[0];
  const voxcpmModel = voxcpmEngine?.models[voxcpmVersion] ?? null;
  const total = 2;
  const canRun = !busy && Boolean(synthesisText.trim()) && engineReady && (!engineNeedsCharacter || Boolean(synthesisCharacterId));
  return <div className="flex flex-col gap-6">
    {step === 0 && <>
      <ControlSection eyebrow={t(locale, "controls.engine.eyebrow")} title={t(locale, "controls.engine.title")}>
        <div className="grid grid-cols-2 gap-2">
          {engines.map((item) => <button aria-pressed={engine === item.id} className={cn("flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left text-xs transition-colors", engine === item.id ? "border-primary bg-accent" : "hover:bg-muted")} disabled={busy !== null} key={item.id} onClick={() => setEngine(item.id)} type="button"><span className="flex w-full items-center justify-between gap-2"><strong className="font-medium">{t(locale, item.labelKey)}</strong>{engine === item.id && <Check className="size-3.5 shrink-0 text-primary" />}</span><small className="text-muted-foreground">{t(locale, item.noteKey)}</small></button>)}
        </div>
      </ControlSection>
      {isVoxCpm ? <ControlSection eyebrow={t(locale, "voxcpm.version.title")} title={t(locale, "voxcpm.version.title")}>
        <div className="grid gap-2">
          <Label htmlFor="voxcpm-version" className="text-xs text-muted-foreground">{t(locale, "voxcpm.version.hint")}</Label>
          <Select disabled={busy !== null} onValueChange={(value) => setVoxcpmVersion(value as VoxCpmVersion)} value={voxcpmVersion}>
            <SelectTrigger id="voxcpm-version" className="h-9 w-full min-w-0"><SelectValue placeholder={t(locale, "voxcpm.version.title")} /></SelectTrigger>
            <SelectContent>{voxcpmVersions.map((item) => { const model = voxcpmEngine?.models[item.id] ?? null; return <SelectItem key={item.id} value={item.id}>{t(locale, item.labelKey)} · {t(locale, item.noteKey)} · {tF(locale, "voxcpm.size", { size: (model?.sizeGb ?? 0).toFixed(1) })}</SelectItem>; })}</SelectContent>
          </Select>
          {voxcpmModel && <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
            <span className="grid min-w-0 gap-0.5"><strong className="truncate text-xs font-medium">{t(locale, selectedVersion.labelKey)}</strong><small className="truncate text-[11px] text-muted-foreground">{tF(locale, "voxcpm.size", { size: voxcpmModel.sizeGb.toFixed(1) })} · {t(locale, selectedVersion.noteKey)}</small></span>
            {voxcpmModel.ready ? <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-primary"><Check className="size-3" />{tF(locale, "voxcpm.ready", { label: t(locale, selectedVersion.labelKey) })}</span> : <Button disabled={busy !== null || Boolean(voxcpmEngine && !voxcpmEngine.runtime)} onClick={() => onInstallVoxCpm(voxcpmVersion)} type="button" variant="outline" size="sm"><Download className="size-3.5" />{tF(locale, "voxcpm.download", { size: voxcpmModel.sizeGb.toFixed(1) })}</Button>}
          </div>}
        </div>
        {voxcpmEngine && !voxcpmEngine.runtime && <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><strong className="text-amber-600">{t(locale, "voxcpm.runtimeMissing")}</strong>{voxcpmEngine.runtimeError && <p className="break-all text-[11px] text-amber-700">{tF(locale, "voxcpm.runtimeError", { error: voxcpmEngine.runtimeError })}</p>}<Button disabled={busy !== null} onClick={onRetryVoxCpmRuntime} type="button" variant="outline" size="sm" className="w-fit"><Download className="size-3.5" />{t(locale, "voxcpm.runtimeInstall")}</Button><p className="text-[11px] text-muted-foreground">{t(locale, "voxcpm.envPrepHint")}</p></div>}
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t(locale, "voxcpm.verifyNote")}</p>
        <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      </ControlSection> : <>
        {engineReady ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "tts.ready")}</p> : <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.tts.title")}>
          <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
          <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />{t(locale, "download.cosyvoice")}</Button>
        </ControlSection>}
      </>}
    </>}
    {step === 1 && <>
      <ControlSection eyebrow={t(locale, "controls.voice.eyebrow")} title={t(locale, "controls.voice.title")}>
        <div className="grid max-h-52 gap-1 overflow-auto pr-1">
          {(!isVoxCpm || voxcpmVersion === "voxcpm2") && <button aria-pressed={!synthesisCharacterId} className={cn("flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", !synthesisCharacterId ? "border-primary bg-accent" : "hover:bg-muted")} disabled={busy !== null} onClick={() => setSynthesisCharacterId("")} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{isVoxCpm ? t(locale, "voxcpm.defaultVoice") : t(locale, "character.defaultVoice")}</strong><small className="truncate text-muted-foreground">{isVoxCpm ? t(locale, "voxcpm.defaultVoiceNote") : t(locale, "character.defaultVoiceNote")}</small></span>{!synthesisCharacterId && <Check className="size-3.5 shrink-0 text-primary" />}</button>}
          {characters.map((character) => <button aria-pressed={synthesisCharacterId === character.id} className={cn("flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", synthesisCharacterId === character.id ? "border-primary bg-accent" : "hover:bg-muted")} disabled={busy !== null} key={character.id} onClick={() => setSynthesisCharacterId(character.id)} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{character.name}</strong><small className="truncate text-muted-foreground">{character.promptText ? tF(locale, "character.promptReady", { count: character.promptText.length }) : t(locale, "character.promptMissing")}</small></span>{synthesisCharacterId === character.id && <Check className="size-3.5 shrink-0 text-primary" />}</button>)}
        </div>
        {engineNeedsCharacter && !synthesisCharacterId && <p className="text-[11px] leading-relaxed text-destructive">{t(locale, "voxcpm.needsCharacter")}</p>}
      </ControlSection>
      {!isVoxCpm && <ControlSection eyebrow={t(locale, "controls.style.eyebrow")} title={t(locale, "controls.style.title")}>
        <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/50 p-1">{styles.map((item) => <Button className={cn(style === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setStyle(item.id)} title={t(locale, item.noteKey)} type="button" variant="ghost" size="sm">{t(locale, item.labelKey)}</Button>)}</div>
      </ControlSection>}
      <ControlSection eyebrow={t(locale, "controls.text.eyebrow")} title={t(locale, "controls.text.title")}>
        <Textarea aria-label={t(locale, "controls.text.title")} disabled={busy !== null} onChange={(event) => setSynthesisText(event.target.value)} placeholder={t(locale, "controls.text.placeholder")} rows={6} value={synthesisText} />
      </ControlSection>
    </>}
    <StepFooter busy={busy} finishDisabled={!canRun} finishLabel={busy === "synthesize" ? <><LoaderCircle className="size-4 animate-spin" />{t(locale, "nav.synthesize.label")}</> : <><Sparkles className="size-4" />{t(locale, "nav.synthesize.label")}</>} onBack={onBack} onFinish={onRun} onNext={onNext} step={step} total={total} />
  </div>;
}

function SelectedSource({ asset }: { asset: MediaAsset }) {
  const locale = useRecutLocale();
  const source = `/v1/media/assets/${encodeURIComponent(asset.id)}/content`;
  return <figure className="overflow-hidden rounded-md border bg-muted/40">
    <div className="grid place-items-center bg-muted">{asset.kind === "video" ? <video className="aspect-video w-full object-cover" controls preload="metadata" src={source} /> : <audio className="w-full" controls preload="metadata" src={source} />}</div>
    <figcaption className="grid gap-0.5 px-2.5 py-2"><strong className="truncate text-xs">{asset.name}</strong><span className="text-[10px] text-muted-foreground">{tF(locale, "source.selected", { kind: kindLabel(locale, asset.kind) })}</span></figcaption>
  </figure>;
}

function Setup({ autoPrepare, busy, elapsedSeconds, failure, failureLogs, logs, message, pythonVersion, onPrepare, onAskAgent }: { autoPrepare: boolean; busy: string | null; elapsedSeconds: number; failure: string; failureLogs: ShellJobLog[]; logs: ShellJobLog[]; message: string; pythonVersion?: string; onPrepare: () => void; onAskAgent: () => void }) {
  const locale = useRecutLocale();
  const started = useRef(false);
  useEffect(() => { if (autoPrepare && !started.current) { started.current = true; onPrepare(); } }, [autoPrepare, onPrepare]);
  const failureText = failureLogs.length ? failureLogs.map((entry) => entry.text).join("") : "";
  return <div className="mx-auto mt-[10vh] w-full max-w-lg">
    <Card className="rounded-lg shadow-none">
      <CardHeader>
        <div className="mb-2 grid size-10 place-items-center rounded-md border bg-accent text-primary"><LoaderCircle className={cn("size-5", busy === "prepare" && "animate-spin")} /></div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "app.title")}</p>
        <CardTitle className="mt-1">{t(locale, "setup.title")}</CardTitle>
        <CardDescription>{t(locale, "setup.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {busy === "prepare" && <><div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-primary"><Clock3 className="size-3.5" />{tF(locale, "setup.runningLabel", { time: formatElapsed(elapsedSeconds) })}</div><pre className="max-h-56 overflow-auto rounded-md bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg" aria-label={t(locale, "aria.setupPrep")}>{logs.length ? logText(logs) : t(locale, "setup.prepLogsLabel")}</pre></>}
        {failure && <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"><strong className="text-sm">{t(locale, "setup.failureTitle")}</strong><p className="break-all leading-relaxed text-destructive">{failure}</p>{pythonVersion && <p className="text-[11px] text-muted-foreground">{tF(locale, "setup.pythonHint", { version: pythonVersion })}</p>}{failureText && <pre className="max-h-56 overflow-auto rounded-md bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg" aria-label={t(locale, "aria.failureLogs")}>{failureText}</pre>}<div className="flex gap-2"><Button disabled={busy !== null} onClick={onAskAgent} type="button" variant="outline" size="sm" className="w-fit text-destructive"><Send className="size-3.5" />{t(locale, "setup.askAgent")}</Button></div></div>}
      </CardContent>
      <CardFooter className="flex-col items-start gap-2">
        <Button disabled={busy !== null} onClick={onPrepare} type="button" variant="outline">{busy === "prepare" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}{busy === "prepare" ? t(locale, "msg.starting") : t(locale, "setup.retry")}</Button>
        <p className="text-xs text-muted-foreground" role="status">{message}</p>
      </CardFooter>
    </Card>
  </div>;
}

function TranscriptOutput({ busy, transcript, onEditSegment, onSave }: { busy: string | null; transcript: TranscriptDetail | null; onEditSegment: (index: number, text: string) => void; onSave: (transcript: TranscriptDetail) => void }) {
  const locale = useRecutLocale();
  const [showSRT, setShowSRT] = useState(false);
  const [copied, setCopied] = useState(false);
  const srt = transcript ? buildSRT(transcript.segments) : "";
  const copy = async () => { if (!transcript) return; if (await copyText(srt)) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } };
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between gap-3 border-b pb-3">
      <div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "output.transcript.eyebrow")}</p><h2 className="mt-0.5 text-sm font-semibold">{t(locale, "output.transcript.title")}</h2></div>
      {transcript && <div className="flex gap-1.5"><Button disabled={!transcript} onClick={() => void copy()} type="button" variant="outline" size="sm">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? t(locale, "copy.copied") : t(locale, "copy.srt")}</Button><Button disabled={!transcript} onClick={() => transcript && downloadBlob(`transcript-${transcript.id}.srt`, srt, "text/plain")} type="button" variant="outline" size="sm"><Download className="size-3.5" />SRT</Button><Button disabled={!transcript} onClick={() => transcript && downloadBlob(`transcript-${transcript.id}.json`, JSON.stringify({ model: transcript.model, language: transcript.language, duration: transcript.duration, segments: transcript.segments }, null, 2), "application/json")} type="button" variant="outline" size="sm"><FileAudio className="size-3.5" />JSON</Button></div>}
    </div>
    <div className="grid flex-1 place-items-center">
      {transcript ? <div className="grid w-full max-w-2xl gap-3">
        <div className="flex flex-wrap items-center gap-1.5"><Badge variant="secondary">{kindLabel(locale, transcript.sourceKind)} · {speechModels.find((item) => item.id === transcript.model)?.label ?? transcript.model}</Badge><Badge variant="secondary">{languageLabel(locale, transcript.language)}</Badge><Badge variant="secondary">{tF(locale, "unit.seconds", { value: transcript.duration.toFixed(1) })}</Badge><Badge variant="secondary">{tF(locale, "unit.segments", { value: transcript.segments.length })}</Badge>{transcript.savedAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div>
        {transcript.audioURL && <audio className="w-full" controls preload="metadata" src={transcript.audioURL} aria-label={t(locale, "aria.transcriptSource")} />}
        <div className="max-h-[340px] overflow-auto rounded-md border">{transcript.segments.map((segment, index) => <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center gap-3 border-b px-3 py-1.5 last:border-0" key={`${transcript.id}-${index}`}><span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">{formatTimecode(segment.start).replace(",", " ").slice(0, 8)} → {formatTimecode(segment.end).replace(",", " ").slice(0, 8)}</span><Input aria-label={tF(locale, "aria.segmentText", { index: index + 1 })} className="h-8 border-transparent bg-transparent shadow-none hover:border-border focus-visible:bg-background" onChange={(event) => onEditSegment(index, event.target.value)} value={segment.text} /></div>)}</div>
        <div className="flex items-center justify-between gap-3"><Button onClick={() => setShowSRT((visible) => !visible)} type="button" variant="ghost" size="sm" className="w-fit px-0 text-primary hover:bg-transparent hover:text-primary"><FileAudio className="size-3.5" />{showSRT ? t(locale, "srt.collapse") : t(locale, "srt.preview")}</Button><p className="text-[11px] text-muted-foreground">{t(locale, "transcript.editableHint")}</p></div>
        {showSRT && <pre className="max-h-52 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{srt}</pre>}
        <div className="flex items-center justify-between gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">{t(locale, "transcript.saveHint")}</p>{transcript.savedAssetId ? <Badge variant="secondary">{t(locale, "badge.savedInLibrary")}</Badge> : <Button disabled={busy !== null} onClick={() => onSave(transcript)} type="button" size="sm">{busy === "save" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}{t(locale, "save.toLibrary")}</Button>}</div>
      </div> : <div className="grid max-w-60 place-items-center gap-2 text-center text-sm text-muted-foreground"><MessageSquareText className="size-7 text-muted-foreground/60" /><p>{t(locale, "transcript.empty")}</p></div>}
    </div>
  </CardContent>;
}

function CharacterPreview({ busy, character, onRemove, onSave }: { busy: string | null; character: VoiceCharacter; onRemove?: () => void; onSave: () => void }) {
  const locale = useRecutLocale();
  return <Card className="rounded-lg shadow-none"><CardHeader className="pb-2"><div className="flex items-center justify-between gap-3"><CardTitle className="min-w-0 truncate text-sm">{character.name}</CardTitle>{character.sampleAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div><CardDescription className="text-[11px]">{tF(locale, "character.referenceTranscript", { model: character.model.replace("whisper-", ""), time: timestamp(locale, character.createdAt) })}</CardDescription></CardHeader><CardContent className="grid gap-3"><audio className="w-full" controls preload="metadata" src={character.sampleURL} /><div className="grid gap-1"><p className="text-[11px] font-medium text-muted-foreground">{t(locale, "character.prompt.label")}</p><p className="max-h-32 overflow-auto rounded-md bg-muted/60 p-2.5 text-xs leading-relaxed">{character.promptText || t(locale, "character.prompt.missing")}</p></div></CardContent><CardFooter className="justify-between gap-2"><Button disabled={busy !== null || Boolean(character.sampleAssetId)} onClick={onSave} type="button" variant="outline" size="sm"><Save className="size-3.5" />{character.sampleAssetId ? t(locale, "badge.savedInLibrary") : t(locale, "save.referenceAudio")}</Button>{onRemove && <Button disabled={busy !== null} onClick={onRemove} type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive"><Trash2 className="size-3.5" />{t(locale, "delete")}</Button>}</CardFooter></Card>;
}

function SynthesisOutput({ busy, selected, syntheses, onSave }: { busy: string | null; selected: Synthesis | null; syntheses: Synthesis[]; onSave: (synthesis: Synthesis) => void }) {
  const locale = useRecutLocale();
  const current = selected ?? syntheses[0] ?? null;
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between border-b pb-3"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "output.synthesis.eyebrow")}</p><h2 className="mt-0.5 text-sm font-semibold">{t(locale, "output.synthesis.title")}</h2></div>{current && (current.savedAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.privatePreview")}</Badge>)}</div>
    <div className="grid flex-1 place-items-center">
      {current ? <div className="grid w-full max-w-md gap-3"><div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"><div className="grid gap-0.5"><strong className="text-xs font-medium">{engineLabel(locale, current.engine)} · {t(locale, "synthesis.current")}</strong><small className="text-[11px] text-muted-foreground">{tF(locale, "synthesis.detail", { style: styleLabel(locale, current.style), duration: current.duration.toFixed(1), time: timestamp(locale, current.createdAt) })}</small></div>{current.savedAssetId ? <Check className="size-4 text-primary" /> : null}</div><audio className="w-full" controls src={current.outputURL} /></div> : <div className="grid max-w-60 place-items-center gap-2 text-center text-sm text-muted-foreground"><Sparkles className="size-7 text-muted-foreground/60" /><p>{t(locale, "synthesis.empty")}</p></div>}
    </div>
    {current && <div className="flex items-center justify-between gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">{t(locale, "synthesis.listenHint")}</p>{current.savedAssetId ? <Badge variant="secondary">{t(locale, "badge.savedInLibrary")}</Badge> : <Button disabled={busy !== null} onClick={() => onSave(current)} type="button" size="sm">{busy === "save" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}{t(locale, "save.toLibrary")}</Button>}</div>}
  </CardContent>;
}

createRoot(document.getElementById("root")!).render(<App />);
