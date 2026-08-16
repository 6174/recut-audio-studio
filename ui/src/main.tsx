/**
 * [INPUT]: 依赖 Recut SDK、声音工坊 operation、平台素材选择器、素材库上传 HTTP、shadcn/ui 组件与 React 状态
 * [OUTPUT]: 对外提供三步声音工作流导航、会话级配音草稿、Download Source、Whisper/Qwen/CosyVoice 模型下载、转写文稿与 SRT、转写保存为素材库 bundle、声音角色创建/试听/删除、角色配音合成与试听，以及历史小卡片点击后在共享详情预览中操作、实时计时/日志、任务停止和用户确认入库工作台
 * [POS]: audio-studio UI 编排层；仅在环境和选定模型就绪后开放推理，生成结果先留在 App 私有文件区；UI 用户可见文案经 i18n.ts 随 locale 切换
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioLines, Check, CircleStop, Clock3, Copy, Download, FileAudio, FolderOpen, LoaderCircle, MessageSquareText, Mic, Save, Send, Sparkles, Trash2, Upload, Video, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { recut, useRecutLocale, type Locale } from "./recut-sdk";
import { t, tF, type I18nKey } from "./i18n";
import type { ActiveAudioJob, DownloadSource, Language, MediaAsset, RuntimeStatus, ShellJob, ShellJobLog, SpeechModel, Synthesis, TranscriptDetail, TranscriptSegment, TranscriptSummary, VoiceCharacter, VoiceStyle } from "./types";
import "./index.css";

type Tab = "transcribe" | "characters" | "synthesize";

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

type ActiveJob = { id: string; action: ActiveAudioJob["action"]; recordID?: string; startedAt: number; status: ShellJob["status"]; error?: string };
type HistoryPreview = { kind: "transcript"; item: TranscriptDetail } | { kind: "character"; item: VoiceCharacter } | { kind: "synthesis"; item: Synthesis };
type SynthesisDraft = { text: string; characterId: string; style: VoiceStyle };

const synthesisDraftStorageKey = "recut.audio-studio.synthesis-draft.v1";

function readSynthesisDraft(): SynthesisDraft {
  try {
    const draft = JSON.parse(window.sessionStorage.getItem(synthesisDraftStorageKey) || "{}") as Partial<SynthesisDraft>;
    return {
      text: typeof draft.text === "string" ? draft.text : "",
      characterId: typeof draft.characterId === "string" ? draft.characterId : "",
      style: draft.style && styles.some((item) => item.id === draft.style) ? draft.style : "neutral",
    };
  } catch (_) { return { text: "", characterId: "", style: "neutral" }; }
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
  const [transcripts, setTranscripts] = useState<TranscriptSummary[]>([]);
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
  const [busy, setBusy] = useState<"prepare" | "install" | "transcribe" | "character" | "synthesize" | "save" | "upload" | "agent" | null>(null);
  const [message, setMessage] = useState(() => t(locale, "msg.starting"));
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [logs, setLogs] = useState<ShellJobLog[]>([]);
  const [bottomTab, setBottomTab] = useState<"history" | "logs">("history");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [failure, setFailure] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState<TranscriptDetail | null>(null);
  const [selectedSynthesis, setSelectedSynthesis] = useState<Synthesis | null>(null);
  const [historyPreview, setHistoryPreview] = useState<HistoryPreview | null>(null);
  const finalizingJob = useRef<string | null>(null);
  const logsRef = useRef<ShellJobLog[]>([]);
  const bottomTabSelectedByUser = useRef(false);

  const selectBottomTab = useCallback((next: "history" | "logs") => { bottomTabSelectedByUser.current = true; setBottomTab(next); }, []);
  const showLogsForNewJob = useCallback(() => { bottomTabSelectedByUser.current = false; setBottomTab("logs"); }, []);

  const refresh = useCallback(async (): Promise<RuntimeStatus | null> => {
    try {
      const nextStatus = await recut.state.query("audio.status") as RuntimeStatus;
      setStatus(nextStatus);
      if (nextStatus.downloadSource) setDownloadSource(nextStatus.downloadSource);
      setMessage(nextStatus.activeJob && isValidActiveJob(nextStatus.activeJob) ? t(locale, "msg.jobRunning") : nextStatus.ready ? t(locale, "msg.ready") : nextStatus.setupError ? tF(locale, "msg.setupFailed", { error: nextStatus.setupError }) : t(locale, "msg.starting"));
      try {
        const [nextTranscripts, nextCharacters, nextSyntheses] = await Promise.all([
          recut.state.query("audio.transcripts") as Promise<TranscriptSummary[]>,
          recut.state.query("audio.characters") as Promise<VoiceCharacter[]>,
          recut.state.query("audio.syntheses") as Promise<Synthesis[]>,
        ]);
        setTranscripts(nextTranscripts); setCharacters(nextCharacters); setSyntheses(nextSyntheses);
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
    if (!bottomTabSelectedByUser.current) setBottomTab("logs");
    setBusy(job.action as ActiveJob["action"]);
    setActiveJob({ id: job.id, action: job.action, recordID: job.recordID, startedAt: jobStartedAt(job.startedAt), status: job.status, error: job.error });
  }, []);

  const syncJob = useCallback(async () => {
    const job = await recut.state.query("audio.job") as ActiveAudioJob | null;
    if (isValidActiveJob(job)) restoreJob(job);
    else { setActiveJob(null); setBusy(null); setCancelling(false); }
  }, [restoreJob]);

  useEffect(() => { logsRef.current = logs; }, [logs]);
  useEffect(() => { saveSynthesisDraft({ text: synthesisText, characterId: synthesisCharacterId, style }); }, [style, synthesisCharacterId, synthesisText]);
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

  const finishJob = useCallback(async (job: ActiveJob) => {
    if (finalizingJob.current === job.id) return;
    finalizingJob.current = job.id;
    try {
      if (job.status !== "completed") {
        const tail = [...logsRef.current].reverse().map((entry) => entry.text.trim()).find(Boolean);
        const error = tail || job.error || t(locale, "msg.taskIncomplete");
        setFailure(error); setMessage(error);
      } else if (job.action === "transcribe" && job.recordID) {
        const detail = await recut.background.call("audio.transcript", { id: job.recordID }) as TranscriptDetail;
        setCurrentTranscript(detail); setMessage(t(locale, "msg.transcribeDone"));
      } else if (job.action === "character" && job.recordID) {
        await recut.background.call("audio.character.complete", { id: job.recordID });
        setMessage(t(locale, "msg.characterCreated"));
      } else if (job.action === "synthesize" && job.recordID) {
        const synthesis = await recut.background.call("audio.synthesis.complete", { id: job.recordID }) as Synthesis;
        setSelectedSynthesis(synthesis); setMessage(t(locale, "msg.synthesisDone"));
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

  const compatibleAssets = useMemo(() => assets.filter((asset) => asset.kind === sourceKind), [assets, sourceKind]);
  const sourceAsset = selectedAsset?.id === assetId ? selectedAsset : compatibleAssets.find((asset) => asset.id === assetId) ?? null;
  const readySpeechModel = Boolean(status?.asr.installed.includes(model));
  const ttsReady = Boolean(status?.tts.ready);
  const running = busy === "prepare" || busy === "install" || busy === "transcribe" || busy === "character" || busy === "synthesize";

  const beginJob = (job: ShellJob, action: ActiveJob["action"], recordID?: string) => {
    setElapsedSeconds(0);
    setActiveJob({ id: job.id, action, recordID, startedAt: jobStartedAt(job.startedAt), status: job.status, error: job.error });
    void syncJob().catch((error) => setMessage(error instanceof Error ? error.message : t(locale, "msg.jobLogFailed")));
  };

  const installSpeechModel = async () => {
    setBusy("install"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(tF(locale, "msg.downloadingModel", { name: speechModels.find((item) => item.id === model)?.label ?? model }));
    try { const result = await recut.background.call("audio.install", { model, source: downloadSource }) as { job: ShellJob }; beginJob(result.job, "install"); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
  };

  const installCosyVoice = async () => {
    setBusy("install"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.downloadingCosyVoice"));
    try { const result = await recut.background.call("audio.install", { model: "cosyvoice2", source: downloadSource }) as { job: ShellJob }; beginJob(result.job, "install"); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.installFailed")); setBusy(null); }
  };

  const prepare = useCallback(async () => {
    setBusy("prepare"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.starting"));
    try { const result = await recut.background.call("audio.prepare") as { job: ShellJob }; beginJob(result.job, "prepare"); }
    catch (error) { const message = error instanceof Error ? error.message : t(locale, "msg.startFailed"); setFailure(message); setMessage(message); setBusy(null); }
  }, [locale]);

  const transcribeSource = async () => {
    if (!assetId) return setMessage(t(locale, "msg.pickSourceFirst"));
    setBusy("transcribe"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(sourceKind === "video" ? t(locale, "msg.extractingVideo") : t(locale, "msg.transcribing"));
    try { const result = await recut.background.call("audio.transcribe", { assetId, kind: sourceKind, model, language }) as { job: ShellJob; transcript: { id: string } }; beginJob(result.job, "transcribe", result.transcript.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.transcribeFailed")); setBusy(null); }
  };

  const createCharacter = async () => {
    if (!characterAssetId) return setMessage(t(locale, "msg.pickReferenceFirst"));
    if (!characterName.trim()) return setMessage(t(locale, "msg.nameCharacter"));
    setBusy("character"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.creatingCharacter"));
    try { const result = await recut.background.call("audio.character.create", { assetId: characterAssetId, name: characterName.trim(), model }) as { job: ShellJob; character: { id: string } }; beginJob(result.job, "character", result.character.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.characterFailed")); setBusy(null); }
  };

  const synthesizeVoice = async () => {
    if (!synthesisText.trim()) return setMessage(t(locale, "msg.enterText"));
    saveSynthesisDraft({ text: synthesisText, characterId: synthesisCharacterId, style });
    setBusy("synthesize"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(t(locale, "msg.synthesizing"));
    try { const result = await recut.background.call("audio.synthesize", { ...(synthesisCharacterId ? { characterId: synthesisCharacterId } : {}), text: synthesisText, style }) as { job: ShellJob; synthesis: { id: string } }; beginJob(result.job, "synthesize", result.synthesis.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.synthesisFailed")); setBusy(null); }
  };

  const cancel = async () => {
    if (!activeJob || isTerminal(activeJob.status)) return;
    setCancelling(true);
    try {
      const result = await recut.background.call("audio.cancel") as { cancelled: boolean };
      setMessage(result.cancelled ? t(locale, "msg.stoppingTask") : t(locale, "msg.noTaskToStop"));
      void syncJob();
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.stopFailed")); }
    finally { setCancelling(false); }
  };

  const chooseSource = async (kinds: string[]) => {
    try {
      const selected = await recut.media.pick(kinds) as MediaAsset | null;
      if (!selected) return;
      setAssets((items) => items.some((asset) => asset.id === selected.id) ? items : [selected, ...items]);
      setSelectedAsset(selected); setAssetId(selected.id); setMessage(tF(locale, "msg.pickedSource", { kind: kindLabel(locale, selected.kind), name: selected.name }));
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
    if (!file.type.startsWith("audio/")) return setMessage(t(locale, "msg.uploadAudioOnly"));
    setBusy("upload");
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/v1/media/assets", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok || !payload.id) throw new Error(payload.error || t(locale, "msg.uploadFailed"));
      const nextAssets = await loadAssets();
      const selected = nextAssets.find((asset) => asset.id === payload.id) ?? { id: payload.id, name: file.name, kind: "audio", mimeType: file.type, status: "completed" };
      if (kind === "character") { setCharacterAsset(selected); setCharacterAssetId(payload.id); }
      else { setSelectedAsset(selected); setAssetId(payload.id); setSourceKind("audio"); }
      setMessage(t(locale, "msg.uploadedSelected"));
    } catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.uploadFailed")); }
    finally { setBusy(null); }
  };

  const saveTranscript = async (transcript: Pick<TranscriptSummary, "id">) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: transcript.id, kind: "transcript" }) as { assetId: string }; setTranscripts((items) => items.map((item) => item.id === transcript.id ? { ...item, savedAssetId: result.assetId } : item)); setCurrentTranscript((current) => current && current.id === transcript.id ? { ...current, savedAssetId: result.assetId } : current); setHistoryPreview((current) => current?.kind === "transcript" && current.item.id === transcript.id ? { ...current, item: { ...current.item, savedAssetId: result.assetId } } : current); setMessage(t(locale, "msg.transcriptSaved")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
    finally { setBusy(null); }
  };

  const saveSynthesis = async (synthesis: Synthesis) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: synthesis.id, kind: "synthesis" }) as { assetId: string }; setSyntheses((items) => items.map((item) => item.id === synthesis.id ? { ...item, savedAssetId: result.assetId } : item)); setHistoryPreview((current) => current?.kind === "synthesis" && current.item.id === synthesis.id ? { ...current, item: { ...current.item, savedAssetId: result.assetId } } : current); setMessage(t(locale, "msg.synthesisSaved")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
    finally { setBusy(null); }
  };

  const saveCharacter = async (character: VoiceCharacter) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: character.id, kind: "character" }) as { assetId: string }; setCharacters((items) => items.map((item) => item.id === character.id ? { ...item, sampleAssetId: result.assetId } : item)); setHistoryPreview((current) => current?.kind === "character" && current.item.id === character.id ? { ...current, item: { ...current.item, sampleAssetId: result.assetId } } : current); setMessage(t(locale, "msg.characterSampleSaved")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.saveFailed")); }
    finally { setBusy(null); }
  };

  const removeCharacter = async (character: VoiceCharacter) => {
    setBusy("save");
    try { await recut.background.call("audio.character.remove", { id: character.id }); setCharacters((items) => items.filter((item) => item.id !== character.id)); setSynthesisCharacterId((current) => current === character.id ? "" : current); setMessage(t(locale, "msg.characterRemoved")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.removeFailed")); }
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
    setCurrentTranscript((current) => current ? { ...current, segments: current.segments.map((segment, cursor) => cursor === index ? { ...segment, text } : segment) } : current);
    setHistoryPreview((current) => current?.kind === "transcript" ? { ...current, item: { ...current.item, segments: current.item.segments.map((segment, cursor) => cursor === index ? { ...segment, text } : segment) } } : current);
  };

  const openHistoryTranscript = async (id: string) => {
    try { const detail = await recut.background.call("audio.transcript", { id }) as TranscriptDetail; setHistoryPreview({ kind: "transcript", item: detail }); }
    catch (error) { setMessage(error instanceof Error ? error.message : t(locale, "msg.openHistoryFailed")); }
  };

  if (!status?.ready) return <Setup autoPrepare={status !== null} busy={busy} elapsedSeconds={elapsedSeconds} failure={status?.setupError || failure || (!status?.pending ? status?.error || "" : "")} failureLogs={status?.setupLogs ?? []} logs={logs} message={message} pythonVersion={status?.pythonVersion} onPrepare={() => void prepare()} onAskAgent={() => void askAgent()} />;

  const controls = <div className="flex flex-col gap-6">
    {tab === "transcribe" && <TranscribeControls busy={busy} downloadSource={downloadSource} language={language} model={model} readySpeechModel={readySpeechModel} setDownloadSource={setDownloadSource} setLanguage={setLanguage} setModel={setModel} sourceAsset={sourceAsset} sourceKind={sourceKind} upload={(file) => void upload(file, "source")} onChoose={() => void chooseSource([sourceKind])} onRun={() => void transcribeSource()} onInstall={() => void installSpeechModel()} onKindChange={(kind) => { setSourceKind(kind); setAssetId(""); setSelectedAsset(null); }} />}
    {tab === "characters" && <CharacterControls busy={busy} characterAsset={characterAsset} characterName={characterName} downloadSource={downloadSource} model={model} readySpeechModel={readySpeechModel} setDownloadSource={setDownloadSource} setCharacterName={setCharacterName} setModel={setModel} upload={(file) => void upload(file, "character")} onChoose={() => void chooseCharacterSource()} onRun={() => void createCharacter()} onInstall={() => void installSpeechModel()} />}
    {tab === "synthesize" && <SynthesizeControls busy={busy} characters={characters} downloadSource={downloadSource} setDownloadSource={setDownloadSource} setSynthesisCharacterId={setSynthesisCharacterId} setSynthesisText={setSynthesisText} setStyle={setStyle} style={style} synthesisCharacterId={synthesisCharacterId} synthesisText={synthesisText} ttsReady={ttsReady} onRun={() => void synthesizeVoice()} onInstall={() => void installCosyVoice()} />}
  </div>;

  const output = tab === "transcribe" ? <TranscriptOutput busy={busy} onSave={(transcript) => void saveTranscript(transcript)} transcript={currentTranscript} onEditSegment={updateSegmentText} />
    : tab === "characters" ? <CharactersOutput busy={busy} characters={characters} onRemove={(character) => void removeCharacter(character)} onSave={(character) => void saveCharacter(character)} />
    : <SynthesisOutput busy={busy} onSave={(synthesis) => void saveSynthesis(synthesis)} selected={selectedSynthesis} syntheses={syntheses} />;

  return <div className="mx-auto max-w-[1440px] p-6">
    <header className="flex flex-col gap-1 border-b pb-5">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "app.header")}</p>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t(locale, "app.title")}</h1>
        <Badge variant="secondary" className="font-mono">{t(locale, "app.badge")}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t(locale, "app.subtitle")}</p>
    </header>
    <WorkflowNav tab={tab} onChange={(nextTab) => { setTab(nextTab); setBottomTab("history"); bottomTabSelectedByUser.current = true; }} />
    <main className="mt-4 grid items-start gap-4 min-[700px]:grid-cols-[minmax(280px,320px)_minmax(0,1fr)]">
      <Card className="rounded-lg shadow-none">{controls}</Card>
      <Card className="min-h-[540px] rounded-lg shadow-none">{output}</Card>
    </main>
    <BottomPanel activeTab={bottomTab} cancelling={cancelling} elapsedSeconds={elapsedSeconds} logs={logs} onCancel={() => void cancel()} onOpenCharacter={(character) => setHistoryPreview({ kind: "character", item: character })} onOpenSynthesis={(synthesis) => setHistoryPreview({ kind: "synthesis", item: synthesis })} onOpenTranscript={(id) => void openHistoryTranscript(id)} onTabChange={selectBottomTab} running={running} tab={tab} transcripts={transcripts} characters={characters} syntheses={syntheses} />
    {historyPreview && <HistoryPreviewDialog busy={busy} onClose={() => setHistoryPreview(null)} onEditSegment={updateSegmentText} onSaveCharacter={(character) => void saveCharacter(character)} onSaveSynthesis={(synthesis) => void saveSynthesis(synthesis)} onSaveTranscript={(transcript) => void saveTranscript(transcript)} preview={historyPreview} />}
  </div>;
}

function WorkflowNav({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const locale = useRecutLocale();
  const workflows: { id: Tab; number: string; icon: ReactNode; labelKey: I18nKey; noteKey: I18nKey }[] = [
    { id: "transcribe", number: "01", icon: <MessageSquareText className="size-4" />, labelKey: "nav.transcribe.label", noteKey: "nav.transcribe.note" },
    { id: "characters", number: "02", icon: <Mic className="size-4" />, labelKey: "nav.characters.label", noteKey: "nav.characters.note" },
    { id: "synthesize", number: "03", icon: <Sparkles className="size-4" />, labelKey: "nav.synthesize.label", noteKey: "nav.synthesize.note" },
  ];
  const activeIndex = workflows.findIndex((item) => item.id === tab);
  return <nav aria-label={t(locale, "workflow.navLabel")} className="mt-4 rounded-lg border bg-card p-3 shadow-none">
    <div className="flex flex-wrap items-end justify-between gap-2 border-b pb-3">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "workflow.eyebrow")}</p>
        <h2 className="mt-0.5 text-sm font-semibold">{t(locale, "workflow.heading")}</h2>
      </div>
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Step {String(activeIndex + 1).padStart(2, "0")} / 03</span>
    </div>
    <div className="mt-3 grid gap-2 min-[700px]:grid-cols-3">
      {workflows.map((item) => {
        const active = item.id === tab;
        return <button aria-current={active ? "step" : undefined} aria-pressed={active} className={cn("group flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors", active ? "border-primary/60 bg-accent/70" : "border-transparent bg-muted/45 hover:border-border hover:bg-muted")} key={item.id} onClick={() => onChange(item.id)} type="button">
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-full border font-mono text-[10px] font-semibold", active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground")}>{active ? <Check className="size-3.5" /> : item.number}</span>
          <span className="grid min-w-0 gap-0.5">
            <span className={cn("flex items-center gap-1.5 text-sm font-semibold", active ? "text-foreground" : "text-foreground/75")}>{item.icon}{t(locale, item.labelKey)}</span>
            <span className="truncate text-[11px] text-muted-foreground">{t(locale, item.noteKey)}</span>
          </span>
        </button>;
      })}
    </div>
  </nav>;
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

function SourceButtons({ busy, onChoose, selectedLabel, onUpload }: { busy: boolean; onChoose: () => void; selectedLabel: string; onUpload: (file: File | undefined) => void }) {
  const locale = useRecutLocale();
  return <div className="grid gap-2">
    <Label className="text-xs text-muted-foreground">{t(locale, "library.label")}</Label>
    <Button disabled={busy} onClick={onChoose} type="button" variant="outline"><FolderOpen className="size-3.5" />{selectedLabel}</Button>
    <Label className="relative inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium shadow-xs transition-colors hover:bg-input/50 disabled:pointer-events-none disabled:opacity-50"><Upload className="size-3.5" />{t(locale, "upload.audio")}<input accept="audio/*" className="sr-only" disabled={busy} onChange={(event) => onUpload(event.target.files?.[0])} type="file" /></Label>
  </div>;
}

function TranscribeControls({ busy, downloadSource, language, model, readySpeechModel, setDownloadSource, setLanguage, setModel, sourceAsset, sourceKind, upload, onChoose, onRun, onInstall, onKindChange }: { busy: string | null; downloadSource: DownloadSource; language: Language; model: SpeechModel; readySpeechModel: boolean; setDownloadSource: (value: DownloadSource) => void; setLanguage: (value: Language) => void; setModel: (value: SpeechModel) => void; sourceAsset: MediaAsset | null; sourceKind: "audio" | "video"; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onInstall: () => void; onKindChange: (kind: "audio" | "video") => void }) {
  const locale = useRecutLocale();
  return <CardContent className="flex flex-col gap-6">
    <ControlSection eyebrow={t(locale, "controls.input.eyebrow")} title={t(locale, "controls.input.sourceTitle")}>
      <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/50 p-1">
        {(["audio", "video"] as ("audio" | "video")[]).map((kind) => <Button className={cn("gap-1.5", sourceKind === kind && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={kind} onClick={() => onKindChange(kind)} type="button" variant="ghost" size="sm">{kind === "audio" ? <AudioLines className="size-3.5" /> : <Video className="size-3.5" />}{kindLabel(locale, kind)}</Button>)}
      </div>
      <SourceButtons busy={busy !== null} onChoose={onChoose} onUpload={upload} selectedLabel={sourceAsset ? t(locale, "source.change") : tF(locale, "source.pick", { kind: kindLabel(locale, sourceKind) })} />
      {sourceAsset && <SelectedSource asset={sourceAsset} />}
    </ControlSection>
    <Separator />
    <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.model.weightsTitle")}>
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "downloaded")}</p> : <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />{t(locale, "download.model")}</Button>}
    </ControlSection>
    <Separator />
    <ControlSection eyebrow={t(locale, "controls.language.eyebrow")} title={t(locale, "controls.language.title")}>
      <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/50 p-1">{languages.map((item) => <Button className={cn(language === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setLanguage(item.id)} type="button" variant="ghost" size="sm">{t(locale, item.labelKey)}</Button>)}</div>
    </ControlSection>
    <Button disabled={busy !== null || !sourceAsset || !readySpeechModel} onClick={onRun} type="button" size="lg">{busy === "transcribe" ? <LoaderCircle className="size-4 animate-spin" /> : <MessageSquareText className="size-4" />}{t(locale, "nav.transcribe.label")}</Button>
  </CardContent>;
}

function CharacterControls({ busy, characterAsset, characterName, downloadSource, model, readySpeechModel, setDownloadSource, setCharacterName, setModel, upload, onChoose, onRun, onInstall }: { busy: string | null; characterAsset: MediaAsset | null; characterName: string; downloadSource: DownloadSource; model: SpeechModel; readySpeechModel: boolean; setDownloadSource: (value: DownloadSource) => void; setCharacterName: (value: string) => void; setModel: (value: SpeechModel) => void; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onInstall: () => void }) {
  const locale = useRecutLocale();
  return <CardContent className="flex flex-col gap-6">
    <ControlSection eyebrow={t(locale, "controls.input.eyebrow")} title={t(locale, "controls.character.title")}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t(locale, "controls.character.desc")}</p>
      <SourceButtons busy={busy !== null} onChoose={onChoose} onUpload={upload} selectedLabel={characterAsset ? t(locale, "source.character.change") : t(locale, "source.character.pick")} />
      {characterAsset && <SelectedSource asset={characterAsset} />}
      <div className="grid gap-2">
        <Label htmlFor="character-name" className="text-xs text-muted-foreground">{t(locale, "character.name.label")}</Label>
        <Input disabled={busy !== null} id="character-name" onChange={(event) => setCharacterName(event.target.value)} placeholder={t(locale, "character.name.placeholder")} value={characterName} />
      </div>
    </ControlSection>
    <Separator />
    <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.character.promptModelTitle")}>
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "downloaded")}</p> : <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />{t(locale, "download.model")}</Button>}
    </ControlSection>
    <Button disabled={busy !== null || !characterAsset || !characterName.trim() || !readySpeechModel} onClick={onRun} type="button" size="lg">{busy === "character" ? <LoaderCircle className="size-4 animate-spin" /> : <Mic className="size-4" />}{t(locale, "controls.character.title")}</Button>
  </CardContent>;
}

function SynthesizeControls({ busy, characters, downloadSource, setDownloadSource, setSynthesisCharacterId, setSynthesisText, setStyle, style, synthesisCharacterId, synthesisText, ttsReady, onRun, onInstall }: { busy: string | null; characters: VoiceCharacter[]; downloadSource: DownloadSource; setDownloadSource: (value: DownloadSource) => void; setSynthesisCharacterId: (value: string) => void; setSynthesisText: (value: string) => void; setStyle: (value: VoiceStyle) => void; style: VoiceStyle; synthesisCharacterId: string; synthesisText: string; ttsReady: boolean; onRun: () => void; onInstall: () => void }) {
  const locale = useRecutLocale();
  return <CardContent className="flex flex-col gap-6">
    <ControlSection eyebrow={t(locale, "controls.text.eyebrow")} title={t(locale, "controls.text.title")}>
      <Textarea aria-label={t(locale, "controls.text.title")} disabled={busy !== null} onChange={(event) => setSynthesisText(event.target.value)} placeholder={t(locale, "controls.text.placeholder")} rows={5} value={synthesisText} />
    </ControlSection>
    <Separator />
    <ControlSection eyebrow={t(locale, "controls.voice.eyebrow")} title={t(locale, "controls.voice.title")}>
      <div className="grid max-h-52 gap-1 overflow-auto pr-1">
        <button aria-pressed={!synthesisCharacterId} className={cn("flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", !synthesisCharacterId ? "border-primary bg-accent" : "hover:bg-muted")} disabled={busy !== null} onClick={() => setSynthesisCharacterId("")} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{t(locale, "character.defaultVoice")}</strong><small className="truncate text-muted-foreground">{t(locale, "character.defaultVoiceNote")}</small></span>{!synthesisCharacterId && <Check className="size-3.5 shrink-0 text-primary" />}</button>
        {characters.map((character) => <button aria-pressed={synthesisCharacterId === character.id} className={cn("flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", synthesisCharacterId === character.id ? "border-primary bg-accent" : "hover:bg-muted")} disabled={busy !== null} key={character.id} onClick={() => setSynthesisCharacterId(character.id)} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{character.name}</strong><small className="truncate text-muted-foreground">{character.promptText ? tF(locale, "character.promptReady", { count: character.promptText.length }) : t(locale, "character.promptMissing")}</small></span>{synthesisCharacterId === character.id && <Check className="size-3.5 shrink-0 text-primary" />}</button>)}
      </div>
    </ControlSection>
    <Separator />
    <ControlSection eyebrow={t(locale, "controls.style.eyebrow")} title={t(locale, "controls.style.title")}>
      <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/50 p-1">{styles.map((item) => <Button className={cn(style === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setStyle(item.id)} title={t(locale, item.noteKey)} type="button" variant="ghost" size="sm">{t(locale, item.labelKey)}</Button>)}</div>
    </ControlSection>
    <Separator />
    {ttsReady ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "tts.ready")}</p> : <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.tts.title")}>
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />{t(locale, "download.cosyvoice")}</Button>
    </ControlSection>}
    <Button disabled={busy !== null || !synthesisText.trim() || !ttsReady} onClick={onRun} type="button" size="lg">{busy === "synthesize" ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{t(locale, "nav.synthesize.label")}</Button>
  </CardContent>;
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

function CharactersOutput({ busy, characters, onRemove, onSave }: { busy: string | null; characters: VoiceCharacter[]; onRemove: (character: VoiceCharacter) => void; onSave: (character: VoiceCharacter) => void }) {
  const locale = useRecutLocale();
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between border-b pb-3"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "output.characters.eyebrow")}</p><h2 className="mt-0.5 text-sm font-semibold">{t(locale, "output.characters.title")}</h2></div><Badge variant="secondary">{tF(locale, "characters.count", { count: characters.length })}</Badge></div>
    <div className="grid flex-1 content-start gap-3 overflow-auto">
      {characters.length ? characters.map((character) => <CharacterPreview busy={busy} character={character} key={character.id} onRemove={() => onRemove(character)} onSave={() => onSave(character)} />) : <div className="grid place-items-center gap-2 py-16 text-center text-sm text-muted-foreground"><Mic className="size-7 text-muted-foreground/60" /><p>{t(locale, "characters.empty")}</p></div>}
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
      {current ? <div className="grid w-full max-w-md gap-3"><div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"><div className="grid gap-0.5"><strong className="text-xs font-medium">{t(locale, "synthesis.current")}</strong><small className="text-[11px] text-muted-foreground">{tF(locale, "synthesis.detail", { style: styleLabel(locale, current.style), duration: current.duration.toFixed(1), time: timestamp(locale, current.createdAt) })}</small></div>{current.savedAssetId ? <Check className="size-4 text-primary" /> : null}</div><audio className="w-full" controls src={current.outputURL} /></div> : <div className="grid max-w-60 place-items-center gap-2 text-center text-sm text-muted-foreground"><Sparkles className="size-7 text-muted-foreground/60" /><p>{t(locale, "synthesis.empty")}</p></div>}
    </div>
    {current && <div className="flex items-center justify-between gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">{t(locale, "synthesis.listenHint")}</p>{current.savedAssetId ? <Badge variant="secondary">{t(locale, "badge.savedInLibrary")}</Badge> : <Button disabled={busy !== null} onClick={() => onSave(current)} type="button" size="sm">{busy === "save" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}{t(locale, "save.toLibrary")}</Button>}</div>}
  </CardContent>;
}

function BottomPanel({ activeTab, cancelling, elapsedSeconds, logs, onCancel, onOpenCharacter, onOpenSynthesis, onOpenTranscript, onTabChange, running, tab, transcripts, characters, syntheses }: { activeTab: "history" | "logs"; cancelling: boolean; elapsedSeconds: number; logs: ShellJobLog[]; onCancel: () => void; onOpenCharacter: (character: VoiceCharacter) => void; onOpenSynthesis: (synthesis: Synthesis) => void; onOpenTranscript: (id: string) => void; onTabChange: (tab: "history" | "logs") => void; running: boolean; tab: Tab; transcripts: TranscriptSummary[]; characters: VoiceCharacter[]; syntheses: Synthesis[] }) {
  const locale = useRecutLocale();
  const historyCount = tab === "transcribe" ? transcripts.length : tab === "characters" ? characters.length : syntheses.length;
  return <Card className="mt-4 rounded-lg shadow-none">
    <div className="flex items-center gap-1 border-b bg-muted/30 px-3 py-2" role="tablist" aria-label={t(locale, "bottom.outputTabsLabel")}>
      <Button aria-controls="audio-history" aria-selected={activeTab === "history"} className={cn("h-8 rounded-md px-3 text-muted-foreground hover:bg-background hover:text-foreground", activeTab === "history" && "bg-background text-foreground shadow-sm ring-1 ring-foreground/10 hover:bg-background")} id="audio-history-tab" onClick={() => onTabChange("history")} role="tab" type="button" variant="ghost" size="sm">{t(locale, "bottom.history")} <Badge variant="secondary" className="ml-1">{historyCount}</Badge></Button>
      <Button aria-controls="audio-logs" aria-selected={activeTab === "logs"} className={cn("h-8 rounded-md px-3 text-muted-foreground hover:bg-background hover:text-foreground", activeTab === "logs" && "bg-background text-foreground shadow-sm ring-1 ring-foreground/10 hover:bg-background")} id="audio-logs-tab" onClick={() => onTabChange("logs")} role="tab" type="button" variant="ghost" size="sm">{t(locale, "bottom.logs")} <Badge variant="secondary" className="ml-1">{logs.length}</Badge></Button>
      {running && <Button className="ml-auto text-destructive hover:text-destructive" disabled={cancelling} onClick={onCancel} type="button" variant="ghost" size="sm"><CircleStop className="size-3.5" />{cancelling ? t(locale, "bottom.stopping") : t(locale, "bottom.stop")}</Button>}
    </div>
    <div className="min-h-40">
      {activeTab === "history" ? <div aria-labelledby="audio-history-tab" id="audio-history" role="tabpanel"><History onOpenCharacter={onOpenCharacter} onOpenSynthesis={onOpenSynthesis} onOpenTranscript={onOpenTranscript} tab={tab} transcripts={transcripts} characters={characters} syntheses={syntheses} /></div> : <div aria-labelledby="audio-logs-tab" className="min-h-40 bg-terminal text-terminal-fg" id="audio-logs" role="tabpanel">{running && <p className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3 font-mono text-[11px] font-semibold text-primary"><Clock3 className="size-3.5" />{tF(locale, "setup.runningLabel", { time: formatElapsed(elapsedSeconds) })}</p>}<pre className="max-h-56 overflow-auto p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{logs.length ? logText(logs) : t(locale, "bottom.waitingLogs")}</pre></div>}
    </div>
  </Card>;
}

function History({ onOpenCharacter, onOpenSynthesis, onOpenTranscript, tab, transcripts, characters, syntheses }: { onOpenCharacter: (character: VoiceCharacter) => void; onOpenSynthesis: (synthesis: Synthesis) => void; onOpenTranscript: (id: string) => void; tab: Tab; transcripts: TranscriptSummary[]; characters: VoiceCharacter[]; syntheses: Synthesis[] }) {
  const locale = useRecutLocale();
  const items = tab === "transcribe" ? transcripts : tab === "characters" ? characters : syntheses;
  return <div><div className="flex items-center justify-between border-b px-4 py-2.5"><h3 className="text-sm font-semibold">{t(locale, "history.allOutputs")}</h3><span className="font-mono text-[11px] text-muted-foreground">{tF(locale, "history.count", { count: items.length })}</span></div>{items.length ? <div className="grid gap-3 p-4 min-[700px]:grid-cols-2">{tab === "transcribe" ? transcripts.map((item) => <HistoryTranscriptCard item={item} key={item.id} onOpen={onOpenTranscript} />) : tab === "characters" ? characters.map((item) => <HistoryCharacterCard item={item} key={item.id} onOpen={onOpenCharacter} />) : syntheses.map((item) => <HistorySynthesisCard item={item} key={item.id} onOpen={onOpenSynthesis} />)}</div> : <p className="px-4 py-4 text-xs text-muted-foreground">{t(locale, "history.empty")}</p>}</div>;
}

function HistoryTranscriptCard({ item, onOpen }: { item: TranscriptSummary; onOpen: (id: string) => void }) {
  const locale = useRecutLocale();
  const label = item.sourceKind === "video" ? t(locale, "history.transcribe.video") : t(locale, "history.transcribe.audio");
  return <button aria-label={tF(locale, "history.transcribe.open", { label })} className="group grid w-full gap-2 rounded-lg border bg-card p-3 text-left shadow-none transition-colors hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(item.id)} type="button"><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-semibold">{label}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{speechModels.find((model) => model.id === item.model)?.label ?? item.model} · {languageLabel(locale, item.language)}</p></div>{item.savedAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div><p className="font-mono text-[10px] text-muted-foreground">{tF(locale, "history.duration", { duration: item.duration.toFixed(1), time: timestamp(locale, item.createdAt) })}</p><p className="text-[11px] text-primary opacity-0 transition-opacity group-hover:opacity-100">{t(locale, "history.open")}</p></button>;
}

function HistoryCharacterCard({ item, onOpen }: { item: VoiceCharacter; onOpen: (item: VoiceCharacter) => void }) {
  const locale = useRecutLocale();
  return <button aria-label={tF(locale, "history.character.open", { name: item.name })} className="group grid w-full gap-2 rounded-lg border bg-card p-3 text-left shadow-none transition-colors hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(item)} type="button"><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-semibold">{item.name}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{item.model.replace("whisper-", "")} · {timestamp(locale, item.createdAt)}</p></div>{item.sampleAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div><p className="line-clamp-2 text-[11px] text-muted-foreground">{tF(locale, "history.prompt", { prompt: item.promptText || t(locale, "character.prompt.missing") })}</p><p className="text-[11px] text-primary opacity-0 transition-opacity group-hover:opacity-100">{t(locale, "history.open")}</p></button>;
}

function HistorySynthesisCard({ item, onOpen }: { item: Synthesis; onOpen: (item: Synthesis) => void }) {
  const locale = useRecutLocale();
  return <button aria-label={t(locale, "history.synthesis.open")} className="group grid w-full gap-2 rounded-lg border bg-card p-3 text-left shadow-none transition-colors hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(item)} type="button"><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-semibold">{tF(locale, "history.synthesis.title", { style: styleLabel(locale, item.style) })}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{tF(locale, "history.duration", { duration: item.duration.toFixed(1), time: timestamp(locale, item.createdAt) })}</p></div>{item.savedAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div><p className="line-clamp-2 text-[11px] text-muted-foreground">{item.text}</p><p className="text-[11px] text-primary opacity-0 transition-opacity group-hover:opacity-100">{t(locale, "history.open")}</p></button>;
}

function HistoryPreviewDialog({ busy, onClose, onEditSegment, onSaveCharacter, onSaveSynthesis, onSaveTranscript, preview }: { busy: string | null; onClose: () => void; onEditSegment: (index: number, text: string) => void; onSaveCharacter: (character: VoiceCharacter) => void; onSaveSynthesis: (synthesis: Synthesis) => void; onSaveTranscript: (transcript: TranscriptDetail) => void; preview: HistoryPreview }) {
  const locale = useRecutLocale();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const title = preview.kind === "transcript" ? t(locale, "dialog.transcript.title") : preview.kind === "character" ? t(locale, "dialog.character.title") : t(locale, "dialog.synthesis.title");
  const content = preview.kind === "transcript"
    ? <TranscriptOutput busy={busy} onEditSegment={onEditSegment} onSave={onSaveTranscript} transcript={preview.item} />
    : preview.kind === "character"
      ? <div className="p-6"><CharacterPreview busy={busy} character={preview.item} onSave={() => onSaveCharacter(preview.item)} /></div>
      : <SynthesisOutput busy={busy} onSave={onSaveSynthesis} selected={preview.item} syntheses={[]} />;

  return <div aria-labelledby="history-preview-title" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-foreground/30 p-4 backdrop-blur-[1px]" onClick={onClose} role="dialog"><div className="relative max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-auto rounded-lg border bg-card shadow-xl" onClick={(event) => event.stopPropagation()}><div className="sticky top-0 z-10 flex items-center justify-between border-b bg-card/95 px-6 py-3 backdrop-blur"><h2 className="text-sm font-semibold" id="history-preview-title">{title}</h2><Button aria-label={t(locale, "dialog.close")} onClick={onClose} type="button" variant="ghost" size="icon"><X className="size-4" /></Button></div>{content}</div></div>;
}

createRoot(document.getElementById("root")!).render(<App />);
