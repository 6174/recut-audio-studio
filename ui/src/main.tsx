/**
 * [INPUT]: 依赖 Recut SDK、声音工坊 operation、平台素材选择器、素材库上传 HTTP、shadcn/ui 组件与 React 状态
 * [OUTPUT]: 对外提供三步声音工作流导航、Download Source、Whisper/Qwen/CosyVoice 模型下载、转写文稿与 SRT、转写保存为素材库 bundle、声音角色创建/试听/删除、角色配音合成与试听、私有预览、历史、实时计时/日志、任务停止和用户确认入库工作台
 * [POS]: audio-studio UI 编排层；仅在环境和选定模型就绪后开放推理，生成结果先留在 App 私有文件区
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioLines, Check, CircleStop, Clock3, Copy, Download, FileAudio, FolderOpen, LoaderCircle, MessageSquareText, Mic, Save, Send, Sparkles, Trash2, Upload, Video } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { recut } from "./recut-sdk";
import type { ActiveAudioJob, DownloadSource, Language, MediaAsset, RuntimeStatus, ShellJob, ShellJobLog, SpeechModel, Synthesis, TranscriptDetail, TranscriptSegment, TranscriptSummary, VoiceCharacter, VoiceStyle } from "./types";
import "./index.css";

type Tab = "transcribe" | "characters" | "synthesize";

const speechModels: { id: SpeechModel; label: string; note: string }[] = [
  { id: "qwen3-asr-0.6b", label: "Qwen3 ASR 0.6B", note: "Qwen，高精度与速度平衡（推荐）" },
  { id: "qwen3-asr-1.7b", label: "Qwen3 ASR 1.7B", note: "Qwen，最高识别质量，需要更多内存" },
  { id: "whisper-small", label: "Whisper Small", note: "最快，适合快速预览" },
  { id: "whisper-medium", label: "Whisper Medium", note: "质量与速度平衡" },
  { id: "whisper-large-v3", label: "Whisper Large-v3", note: "高精度，更慢" },
];

const downloadSources: { id: DownloadSource; label: string; note: string }[] = [
  { id: "automatic", label: "自动", note: "优先 Hugging Face，不可用时切换 ModelScope" },
  { id: "huggingface", label: "Hugging Face", note: "官方全球源" },
  { id: "modelscope", label: "ModelScope", note: "中国大陆访问通常更稳定" },
];

const languages: { id: Language; label: string }[] = [
  { id: "auto", label: "自动检测" },
  { id: "zh", label: "中文" },
  { id: "en", label: "英文" },
];

const styles: { id: VoiceStyle; label: string; note: string }[] = [
  { id: "neutral", label: "中性", note: "自然陈述" },
  { id: "calm", label: "平静", note: "舒缓放松" },
  { id: "excited", label: "兴奋", note: "热情上扬" },
  { id: "gentle", label: "温柔", note: "柔和亲切" },
];

type ActiveJob = { id: string; action: ActiveAudioJob["action"]; recordID?: string; startedAt: number; status: ShellJob["status"]; error?: string };

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
function timestamp(createdAt: string) { return new Date(createdAt).toLocaleString("zh-CN"); }

function App() {
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
  const [synthesisText, setSynthesisText] = useState("");
  const [synthesisCharacterId, setSynthesisCharacterId] = useState("");
  const [style, setStyle] = useState<VoiceStyle>("neutral");
  const [busy, setBusy] = useState<"prepare" | "install" | "transcribe" | "character" | "synthesize" | "save" | "upload" | "agent" | null>(null);
  const [message, setMessage] = useState("正在启动…");
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [logs, setLogs] = useState<ShellJobLog[]>([]);
  const [bottomTab, setBottomTab] = useState<"history" | "logs">("history");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [failure, setFailure] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState<TranscriptDetail | null>(null);
  const [selectedSynthesis, setSelectedSynthesis] = useState<Synthesis | null>(null);
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
      setMessage(nextStatus.activeJob && isValidActiveJob(nextStatus.activeJob) ? "本地任务正在执行。" : nextStatus.ready ? "运行环境就绪，请开始使用。" : nextStatus.setupError ? `运行环境准备失败：${nextStatus.setupError}` : "正在启动…");
      try {
        const [nextTranscripts, nextCharacters, nextSyntheses] = await Promise.all([
          recut.state.query("audio.transcripts") as Promise<TranscriptSummary[]>,
          recut.state.query("audio.characters") as Promise<VoiceCharacter[]>,
          recut.state.query("audio.syntheses") as Promise<Synthesis[]>,
        ]);
        setTranscripts(nextTranscripts); setCharacters(nextCharacters); setSyntheses(nextSyntheses);
      } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取历史输出。"); }
      return nextStatus;
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取声音工坊状态。"); }
    return null;
  }, []);

  const loadAssets = useCallback(async (): Promise<MediaAsset[]> => {
    const response = await fetch("/v1/media/assets");
    if (!response.ok) throw new Error("无法读取素材库。");
    const next = await response.json() as MediaAsset[];
    const completed = next.filter((asset) => asset.status === "completed" && (asset.kind === "audio" || asset.kind === "video"));
    setAssets(completed); return completed;
  }, []);

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
    const timer = window.setInterval(() => { void syncJob().catch((error) => setMessage(error instanceof Error ? error.message : "无法同步本地任务。")); }, 1000);
    return () => window.clearInterval(timer);
  }, [activeJob, syncJob]);
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
        const error = tail || job.error || "本地任务未完成。";
        setFailure(error); setMessage(error);
      } else if (job.action === "transcribe" && job.recordID) {
        const detail = await recut.background.call("audio.transcript", { id: job.recordID }) as TranscriptDetail;
        setCurrentTranscript(detail); setMessage("转写完成，文稿与字幕已生成，尚未进入素材库。");
      } else if (job.action === "character" && job.recordID) {
        await recut.background.call("audio.character.complete", { id: job.recordID });
        setMessage("声音角色已创建。");
      } else if (job.action === "synthesize" && job.recordID) {
        const synthesis = await recut.background.call("audio.synthesis.complete", { id: job.recordID }) as Synthesis;
        setSelectedSynthesis(synthesis); setMessage("配音已生成，尚未进入素材库。");
      } else {
        const nextStatus = await refresh();
        if (!nextStatus?.ready) {
          const error = nextStatus?.error || "运行环境检查尚未完成，请重新尝试。";
          setFailure(error); setMessage(error); return;
        }
        setMessage(job.action === "prepare" ? "运行环境已就绪。" : "模型下载完成，可以开始使用。");
      }
    } catch (error) { const message = error instanceof Error ? error.message : "任务完成后无法刷新状态。"; setFailure(message); setMessage(message); }
    finally {
      try { await recut.background.call("audio.resolve", { id: job.id }); }
      catch (error) { setMessage(error instanceof Error ? error.message : "无法确认任务终态。"); }
      setBusy(null); setActiveJob((current) => current?.id === job.id ? null : current); finalizingJob.current = null;
      void refresh();
    }
  }, [refresh]);
  useEffect(() => { if (activeJob && isTerminal(activeJob.status)) void finishJob(activeJob); }, [activeJob, finishJob]);

  const compatibleAssets = useMemo(() => assets.filter((asset) => asset.kind === sourceKind), [assets, sourceKind]);
  const sourceAsset = selectedAsset?.id === assetId ? selectedAsset : compatibleAssets.find((asset) => asset.id === assetId) ?? null;
  const readySpeechModel = Boolean(status?.asr.installed.includes(model));
  const ttsReady = Boolean(status?.tts.ready);
  const running = busy === "prepare" || busy === "install" || busy === "transcribe" || busy === "character" || busy === "synthesize";

  const beginJob = (job: ShellJob, action: ActiveJob["action"], recordID?: string) => {
    setElapsedSeconds(0);
    setActiveJob({ id: job.id, action, recordID, startedAt: jobStartedAt(job.startedAt), status: job.status, error: job.error });
    void syncJob().catch((error) => setMessage(error instanceof Error ? error.message : "无法读取本地任务日志。"));
  };

  const installSpeechModel = async () => {
    setBusy("install"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(`正在下载 ${speechModels.find((item) => item.id === model)?.label} 模型…`);
    try { const result = await recut.background.call("audio.install", { model, source: downloadSource }) as { job: ShellJob }; beginJob(result.job, "install"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "安装失败。"); setBusy(null); }
  };

  const installCosyVoice = async () => {
    setBusy("install"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage("正在下载 CosyVoice2-0.5B 权重（约 2.7GB）…");
    try { const result = await recut.background.call("audio.install", { model: "cosyvoice2", source: downloadSource }) as { job: ShellJob }; beginJob(result.job, "install"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "安装失败。"); setBusy(null); }
  };

  const prepare = useCallback(async () => {
    setBusy("prepare"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage("正在启动…");
    try { const result = await recut.background.call("audio.prepare") as { job: ShellJob }; beginJob(result.job, "prepare"); }
    catch (error) { const message = error instanceof Error ? error.message : "暂时无法启动。"; setFailure(message); setMessage(message); setBusy(null); }
  }, []);

  const transcribeSource = async () => {
    if (!assetId) return setMessage("先选择一个音频或视频素材。");
    setBusy("transcribe"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage(sourceKind === "video" ? "正在抽取音轨并转写，视频会花更长时间。" : "正在转写…");
    try { const result = await recut.background.call("audio.transcribe", { assetId, kind: sourceKind, model, language }) as { job: ShellJob; transcript: { id: string } }; beginJob(result.job, "transcribe", result.transcript.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : "转写失败。"); setBusy(null); }
  };

  const createCharacter = async () => {
    if (!characterAssetId) return setMessage("先选择一段参考人声音频。");
    if (!characterName.trim()) return setMessage("给声音角色起一个名字。");
    setBusy("character"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage("正在抽取参考音并生成角色提示词…");
    try { const result = await recut.background.call("audio.character.create", { assetId: characterAssetId, name: characterName.trim(), model }) as { job: ShellJob; character: { id: string } }; beginJob(result.job, "character", result.character.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : "创建角色失败。"); setBusy(null); }
  };

  const synthesizeVoice = async () => {
    if (!synthesisCharacterId) return setMessage("先选择一个声音角色。");
    if (!synthesisText.trim()) return setMessage("先输入要朗读的文本。");
    setBusy("synthesize"); setFailure(""); showLogsForNewJob(); setLogs([]);
    setMessage("正在合成配音…");
    try { const result = await recut.background.call("audio.synthesize", { characterId: synthesisCharacterId, text: synthesisText, style }) as { job: ShellJob; synthesis: { id: string } }; beginJob(result.job, "synthesize", result.synthesis.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : "合成失败。"); setBusy(null); }
  };

  const cancel = async () => {
    if (!activeJob || isTerminal(activeJob.status)) return;
    setCancelling(true);
    try {
      const result = await recut.background.call("audio.cancel") as { cancelled: boolean };
      setMessage(result.cancelled ? "正在停止本地任务…" : "没有可停止的本地任务。");
      void syncJob();
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法停止本地任务。"); }
    finally { setCancelling(false); }
  };

  const chooseSource = async (kinds: string[]) => {
    try {
      const selected = await recut.media.pick(kinds) as MediaAsset | null;
      if (!selected) return;
      setAssets((items) => items.some((asset) => asset.id === selected.id) ? items : [selected, ...items]);
      setSelectedAsset(selected); setAssetId(selected.id); setMessage(`已选择${selected.kind === "audio" ? "音频" : "视频"}素材：${selected.name}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法打开素材选择器。"); }
  };

  const chooseCharacterSource = async () => {
    try {
      const selected = await recut.media.pick(["audio"]) as MediaAsset | null;
      if (!selected) return;
      setAssets((items) => items.some((asset) => asset.id === selected.id) ? items : [selected, ...items]);
      setCharacterAsset(selected); setCharacterAssetId(selected.id); setMessage(`已选择参考人声：${selected.name}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法打开素材选择器。"); }
  };

  const upload = async (file: File | undefined, kind: "source" | "character") => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) return setMessage("请上传音频文件。");
    setBusy("upload");
    try {
      const form = new FormData(); form.append("file", file);
      const response = await fetch("/v1/media/assets", { method: "POST", body: form });
      const payload = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok || !payload.id) throw new Error(payload.error || "上传失败。");
      const nextAssets = await loadAssets();
      const selected = nextAssets.find((asset) => asset.id === payload.id) ?? { id: payload.id, name: file.name, kind: "audio", mimeType: file.type, status: "completed" };
      if (kind === "character") { setCharacterAsset(selected); setCharacterAssetId(payload.id); }
      else { setSelectedAsset(selected); setAssetId(payload.id); setSourceKind("audio"); }
      setMessage("输入素材已加入素材库并选中。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "上传失败。"); }
    finally { setBusy(null); }
  };

  const saveTranscript = async (transcript: TranscriptDetail) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: transcript.id, kind: "transcript" }) as { assetId: string }; setTranscripts((items) => items.map((item) => item.id === transcript.id ? { ...item, savedAssetId: result.assetId } : item)); setCurrentTranscript((current) => current && current.id === transcript.id ? { ...current, savedAssetId: result.assetId } : current); setMessage("转写文稿已保存为素材库的转写素材。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存失败。"); }
    finally { setBusy(null); }
  };

  const saveSynthesis = async (synthesis: Synthesis) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: synthesis.id, kind: "synthesis" }) as { assetId: string }; setSyntheses((items) => items.map((item) => item.id === synthesis.id ? { ...item, savedAssetId: result.assetId } : item)); setMessage("配音已保存到素材库。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存失败。"); }
    finally { setBusy(null); }
  };

  const saveCharacter = async (character: VoiceCharacter) => {
    setBusy("save");
    try { const result = await recut.background.call("audio.save", { id: character.id, kind: "character" }) as { assetId: string }; setCharacters((items) => items.map((item) => item.id === character.id ? { ...item, sampleAssetId: result.assetId } : item)); setMessage("角色参考音已保存到素材库。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存失败。"); }
    finally { setBusy(null); }
  };

  const removeCharacter = async (character: VoiceCharacter) => {
    setBusy("save");
    try { await recut.background.call("audio.character.remove", { id: character.id }); setCharacters((items) => items.filter((item) => item.id !== character.id)); setSynthesisCharacterId((current) => current === character.id ? "" : current); setMessage("声音角色已删除。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "删除失败。"); }
    finally { setBusy(null); }
  };

  const askAgent = async () => {
    setBusy("agent");
    const details = (status?.setupLogs ?? []).map((entry) => entry.text).join("").slice(-2000);
    const context = status?.setupError || status?.error || message;
    const pythonHint = status?.pythonVersion ? `\n当前 venv 使用 Python ${status.pythonVersion}。` : "";
    try { await recut.agent.compose(`声音工坊本地依赖检查或安装失败。请检查并解决这个错误，然后告诉我可以如何继续。\n错误：${context}${pythonHint}\n日志：\n${details || "（无日志）"}`); setMessage("诊断已填入右侧 Agent 输入框；请确认后发送。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "无法准备诊断请求。"); }
    finally { setBusy(null); }
  };

  const updateSegmentText = (index: number, text: string) => {
    setCurrentTranscript((current) => current ? { ...current, segments: current.segments.map((segment, cursor) => cursor === index ? { ...segment, text } : segment) } : current);
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
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Recut App / Audio Intelligence</p>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">声音工坊</h1>
        <Badge variant="secondary" className="font-mono">Standalone App</Badge>
      </div>
      <p className="text-sm text-muted-foreground">转写、声音角色与角色配音。声音是视频的一级资源，输出先留在私有区，确认后再进素材库。</p>
    </header>
    <WorkflowNav tab={tab} onChange={(nextTab) => { setTab(nextTab); setBottomTab("history"); bottomTabSelectedByUser.current = true; }} />
    <main className="mt-4 grid items-start gap-4 min-[700px]:grid-cols-[minmax(280px,320px)_minmax(0,1fr)]">
      <Card className="rounded-lg shadow-none">{controls}</Card>
      <Card className="min-h-[540px] rounded-lg shadow-none">{output}</Card>
    </main>
    <BottomPanel activeTab={bottomTab} cancelling={cancelling} elapsedSeconds={elapsedSeconds} logs={logs} onCancel={() => void cancel()} onTabChange={selectBottomTab} running={running} tab={tab} transcripts={transcripts} characters={characters} syntheses={syntheses} />
  </div>;
}

function WorkflowNav({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const workflows: { id: Tab; number: string; icon: ReactNode; label: string; note: string }[] = [
    { id: "transcribe", number: "01", icon: <MessageSquareText className="size-4" />, label: "转写", note: "音视频 → 文稿与字幕" },
    { id: "characters", number: "02", icon: <Mic className="size-4" />, label: "声音角色", note: "参考音 → 可复用角色" },
    { id: "synthesize", number: "03", icon: <Sparkles className="size-4" />, label: "配音", note: "角色 + 文本 → 音频" },
  ];
  const activeIndex = workflows.findIndex((item) => item.id === tab);
  return <nav aria-label="声音工作流" className="mt-4 rounded-lg border bg-card p-3 shadow-none">
    <div className="flex flex-wrap items-end justify-between gap-2 border-b pb-3">
      <div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">工作流</p>
        <h2 className="mt-0.5 text-sm font-semibold">选择你现在要处理的声音任务</h2>
      </div>
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Step {String(activeIndex + 1).padStart(2, "0")} / 03</span>
    </div>
    <div className="mt-3 grid gap-2 min-[700px]:grid-cols-3">
      {workflows.map((item) => {
        const active = item.id === tab;
        return <button aria-current={active ? "step" : undefined} aria-pressed={active} className={cn("group flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors", active ? "border-primary/60 bg-accent/70" : "border-transparent bg-muted/45 hover:border-border hover:bg-muted")} key={item.id} onClick={() => onChange(item.id)} type="button">
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-full border font-mono text-[10px] font-semibold", active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground")}>{active ? <Check className="size-3.5" /> : item.number}</span>
          <span className="grid min-w-0 gap-0.5">
            <span className={cn("flex items-center gap-1.5 text-sm font-semibold", active ? "text-foreground" : "text-foreground/75")}>{item.icon}{item.label}</span>
            <span className="truncate text-[11px] text-muted-foreground">{item.note}</span>
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
  return <div className="grid gap-2">
    <Label htmlFor="speech-model" className="text-xs text-muted-foreground">本地语音模型</Label>
    <Select disabled={disabled} onValueChange={(value) => onChange(value as SpeechModel)} value={model}>
      <SelectTrigger id="speech-model" className="h-9 w-full min-w-0"><SelectValue placeholder="选择模型" /></SelectTrigger>
      <SelectContent>{speechModels.map((item) => <SelectItem key={item.id} value={item.id}>{item.label} · {item.note}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

function DownloadSourceSelect({ disabled, source, onChange }: { disabled: boolean; source: DownloadSource; onChange: (value: DownloadSource) => void }) {
  const selected = downloadSources.find((item) => item.id === source);
  return <div className="grid gap-2">
    <Label htmlFor="download-source" className="text-xs text-muted-foreground">下载来源</Label>
    <Select disabled={disabled} onValueChange={(value) => onChange(value as DownloadSource)} value={source}>
      <SelectTrigger id="download-source" className="h-9 w-full min-w-0"><SelectValue placeholder="选择下载来源" /></SelectTrigger>
      <SelectContent>{downloadSources.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
    <p className="text-[11px] leading-relaxed text-muted-foreground">{selected?.note}</p>
  </div>;
}

function SourceButtons({ busy, onChoose, selectedLabel, onUpload }: { busy: boolean; onChoose: () => void; selectedLabel: string; onUpload: (file: File | undefined) => void }) {
  return <div className="grid gap-2">
    <Label className="text-xs text-muted-foreground">素材库</Label>
    <Button disabled={busy} onClick={onChoose} type="button" variant="outline"><FolderOpen className="size-3.5" />{selectedLabel}</Button>
    <Label className="relative inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium shadow-xs transition-colors hover:bg-input/50 disabled:pointer-events-none disabled:opacity-50"><Upload className="size-3.5" />上传音频<input accept="audio/*" className="sr-only" disabled={busy} onChange={(event) => onUpload(event.target.files?.[0])} type="file" /></Label>
  </div>;
}

function TranscribeControls({ busy, downloadSource, language, model, readySpeechModel, setDownloadSource, setLanguage, setModel, sourceAsset, sourceKind, upload, onChoose, onRun, onInstall, onKindChange }: { busy: string | null; downloadSource: DownloadSource; language: Language; model: SpeechModel; readySpeechModel: boolean; setDownloadSource: (value: DownloadSource) => void; setLanguage: (value: Language) => void; setModel: (value: SpeechModel) => void; sourceAsset: MediaAsset | null; sourceKind: "audio" | "video"; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onInstall: () => void; onKindChange: (kind: "audio" | "video") => void }) {
  return <CardContent className="flex flex-col gap-6">
    <ControlSection eyebrow="输入" title="选择音视频素材">
      <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/50 p-1">
        {(["audio", "video"] as ("audio" | "video")[]).map((kind) => <Button className={cn("gap-1.5", sourceKind === kind && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={kind} onClick={() => onKindChange(kind)} type="button" variant="ghost" size="sm">{kind === "audio" ? <AudioLines className="size-3.5" /> : <Video className="size-3.5" />}{kind === "audio" ? "音频" : "视频"}</Button>)}
      </div>
      <SourceButtons busy={busy !== null} onChoose={onChoose} onUpload={upload} selectedLabel={sourceAsset ? "更换素材" : `从素材库选择${sourceKind === "audio" ? "音频" : "视频"}`} />
      {sourceAsset && <SelectedSource asset={sourceAsset} />}
    </ControlSection>
    <Separator />
    <ControlSection eyebrow="模型" title="本地语音权重">
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />已下载</p> : <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />下载此模型</Button>}
    </ControlSection>
    <Separator />
    <ControlSection eyebrow="语言" title="转写语言">
      <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/50 p-1">{languages.map((item) => <Button className={cn(language === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setLanguage(item.id)} type="button" variant="ghost" size="sm">{item.label}</Button>)}</div>
    </ControlSection>
    <Button disabled={busy !== null || !sourceAsset || !readySpeechModel} onClick={onRun} type="button" size="lg">{busy === "transcribe" ? <LoaderCircle className="size-4 animate-spin" /> : <MessageSquareText className="size-4" />}开始转写</Button>
  </CardContent>;
}

function CharacterControls({ busy, characterAsset, characterName, downloadSource, model, readySpeechModel, setDownloadSource, setCharacterName, setModel, upload, onChoose, onRun, onInstall }: { busy: string | null; characterAsset: MediaAsset | null; characterName: string; downloadSource: DownloadSource; model: SpeechModel; readySpeechModel: boolean; setDownloadSource: (value: DownloadSource) => void; setCharacterName: (value: string) => void; setModel: (value: SpeechModel) => void; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onInstall: () => void }) {
  return <CardContent className="flex flex-col gap-6">
    <ControlSection eyebrow="输入" title="创建声音角色">
      <p className="text-xs leading-relaxed text-muted-foreground">用一段 5~15 秒干净人声创建可复用角色；超过 30 秒会被自动裁剪。</p>
      <SourceButtons busy={busy !== null} onChoose={onChoose} onUpload={upload} selectedLabel={characterAsset ? "更换参考人声" : "从素材库选择人声音频"} />
      {characterAsset && <SelectedSource asset={characterAsset} />}
      <div className="grid gap-2">
        <Label htmlFor="character-name" className="text-xs text-muted-foreground">角色名称</Label>
        <Input disabled={busy !== null} id="character-name" onChange={(event) => setCharacterName(event.target.value)} placeholder="例如：妈妈" value={characterName} />
      </div>
    </ControlSection>
    <Separator />
    <ControlSection eyebrow="模型" title="提示词语音模型">
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />已下载</p> : <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />下载此模型</Button>}
    </ControlSection>
    <Button disabled={busy !== null || !characterAsset || !characterName.trim() || !readySpeechModel} onClick={onRun} type="button" size="lg">{busy === "character" ? <LoaderCircle className="size-4 animate-spin" /> : <Mic className="size-4" />}创建声音角色</Button>
  </CardContent>;
}

function SynthesizeControls({ busy, characters, downloadSource, setDownloadSource, setSynthesisCharacterId, setSynthesisText, setStyle, style, synthesisCharacterId, synthesisText, ttsReady, onRun, onInstall }: { busy: string | null; characters: VoiceCharacter[]; downloadSource: DownloadSource; setDownloadSource: (value: DownloadSource) => void; setSynthesisCharacterId: (value: string) => void; setSynthesisText: (value: string) => void; setStyle: (value: VoiceStyle) => void; style: VoiceStyle; synthesisCharacterId: string; synthesisText: string; ttsReady: boolean; onRun: () => void; onInstall: () => void }) {
  return <CardContent className="flex flex-col gap-6">
    <ControlSection eyebrow="文本" title="要朗读的内容">
      <Textarea aria-label="要朗读的文本" disabled={busy !== null} onChange={(event) => setSynthesisText(event.target.value)} placeholder="例如：欢迎来到我的频道，今天我们学习 AI。" rows={5} value={synthesisText} />
    </ControlSection>
    <Separator />
    <ControlSection eyebrow="声音" title="选择声音角色">
      {characters.length ? <div className="grid max-h-52 gap-1 overflow-auto pr-1">{characters.map((character) => <button aria-pressed={synthesisCharacterId === character.id} className={cn("flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", synthesisCharacterId === character.id ? "border-primary bg-accent" : "hover:bg-muted")} disabled={busy !== null} key={character.id} onClick={() => setSynthesisCharacterId(character.id)} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{character.name}</strong><small className="truncate text-muted-foreground">{character.promptText ? `提示词已就绪 · ${character.promptText.length} 字` : "提示词未生成"}</small></span>{synthesisCharacterId === character.id && <Check className="size-3.5 shrink-0 text-primary" />}</button>)}</div> : <p className="text-xs leading-relaxed text-muted-foreground">还没有声音角色，先到“声音角色”创建。</p>}
    </ControlSection>
    <Separator />
    <ControlSection eyebrow="风格" title="情绪指令">
      <div className="grid grid-cols-2 gap-1 rounded-md border bg-muted/50 p-1">{styles.map((item) => <Button className={cn(style === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setStyle(item.id)} title={item.note} type="button" variant="ghost" size="sm">{item.label}</Button>)}</div>
    </ControlSection>
    <Separator />
    {ttsReady ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />CosyVoice2 已就绪</p> : <ControlSection eyebrow="模型" title="CosyVoice2 权重">
      <DownloadSourceSelect disabled={busy !== null} source={downloadSource} onChange={setDownloadSource} />
      <Button disabled={busy !== null} onClick={onInstall} type="button" variant="outline"><Download className="size-3.5" />下载 CosyVoice2 权重</Button>
    </ControlSection>}
    <Button disabled={busy !== null || !synthesisCharacterId || !synthesisText.trim() || !ttsReady} onClick={onRun} type="button" size="lg">{busy === "synthesize" ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}合成配音</Button>
  </CardContent>;
}

function SelectedSource({ asset }: { asset: MediaAsset }) {
  const source = `/v1/media/assets/${encodeURIComponent(asset.id)}/content`;
  return <figure className="overflow-hidden rounded-md border bg-muted/40">
    <div className="grid place-items-center bg-muted">{asset.kind === "video" ? <video className="aspect-video w-full object-cover" controls preload="metadata" src={source} /> : <audio className="w-full" controls preload="metadata" src={source} />}</div>
    <figcaption className="grid gap-0.5 px-2.5 py-2"><strong className="truncate text-xs">{asset.name}</strong><span className="text-[10px] text-muted-foreground">{asset.kind === "audio" ? "音频" : "视频"} · 已选择</span></figcaption>
  </figure>;
}

function Setup({ autoPrepare, busy, elapsedSeconds, failure, failureLogs, logs, message, pythonVersion, onPrepare, onAskAgent }: { autoPrepare: boolean; busy: string | null; elapsedSeconds: number; failure: string; failureLogs: ShellJobLog[]; logs: ShellJobLog[]; message: string; pythonVersion?: string; onPrepare: () => void; onAskAgent: () => void }) {
  const started = useRef(false);
  useEffect(() => { if (autoPrepare && !started.current) { started.current = true; onPrepare(); } }, [autoPrepare, onPrepare]);
  const failureText = failureLogs.length ? failureLogs.map((entry) => entry.text).join("") : "";
  return <div className="mx-auto mt-[10vh] w-full max-w-lg">
    <Card className="rounded-lg shadow-none">
      <CardHeader>
        <div className="mb-2 grid size-10 place-items-center rounded-md border bg-accent text-primary"><LoaderCircle className={cn("size-5", busy === "prepare" && "animate-spin")} /></div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">声音工坊</p>
        <CardTitle className="mt-1">正在启动</CardTitle>
        <CardDescription>首次使用需要一点时间，完成后即可选择模型、转写或创建声音角色。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {busy === "prepare" && <><div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-primary"><Clock3 className="size-3.5" />任务运行中 · {formatElapsed(elapsedSeconds)}</div><pre className="max-h-56 overflow-auto rounded-md bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg" aria-label="准备过程">{logs.length ? logText(logs) : "正在启动本地运行环境…"}</pre></>}
        {failure && <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"><strong className="text-sm">运行环境准备失败</strong><p className="break-all leading-relaxed text-destructive">{failure}</p>{pythonVersion && <p className="text-[11px] text-muted-foreground">当前 venv 使用 Python {pythonVersion}；若日志显示无法找到依赖版本，通常是当前 Python 没有对应 wheel，可切换 Python 版本或重试。</p>}{failureText && <pre className="max-h-56 overflow-auto rounded-md bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg" aria-label="失败日志">{failureText}</pre>}<div className="flex gap-2"><Button disabled={busy !== null} onClick={onAskAgent} type="button" variant="outline" size="sm" className="w-fit text-destructive"><Send className="size-3.5" />交给右侧 Codex 处理</Button></div></div>}
      </CardContent>
      <CardFooter className="flex-col items-start gap-2">
        <Button disabled={busy !== null} onClick={onPrepare} type="button" variant="outline">{busy === "prepare" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}{busy === "prepare" ? "正在启动…" : "重新尝试"}</Button>
        <p className="text-xs text-muted-foreground" role="status">{message}</p>
      </CardFooter>
    </Card>
  </div>;
}

function TranscriptOutput({ busy, transcript, onEditSegment, onSave }: { busy: string | null; transcript: TranscriptDetail | null; onEditSegment: (index: number, text: string) => void; onSave: (transcript: TranscriptDetail) => void }) {
  const [showSRT, setShowSRT] = useState(false);
  const [copied, setCopied] = useState(false);
  const srt = transcript ? buildSRT(transcript.segments) : "";
  const copy = async () => { if (!transcript) return; if (await copyText(srt)) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } };
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between gap-3 border-b pb-3">
      <div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">文稿</p><h2 className="mt-0.5 text-sm font-semibold">转写与字幕</h2></div>
      {transcript && <div className="flex gap-1.5"><Button disabled={!transcript} onClick={() => void copy()} type="button" variant="outline" size="sm">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "已复制" : "复制 SRT"}</Button><Button disabled={!transcript} onClick={() => transcript && downloadBlob(`transcript-${transcript.id}.srt`, srt, "text/plain")} type="button" variant="outline" size="sm"><Download className="size-3.5" />SRT</Button><Button disabled={!transcript} onClick={() => transcript && downloadBlob(`transcript-${transcript.id}.json`, JSON.stringify({ model: transcript.model, language: transcript.language, duration: transcript.duration, segments: transcript.segments }, null, 2), "application/json")} type="button" variant="outline" size="sm"><FileAudio className="size-3.5" />JSON</Button></div>}
    </div>
    <div className="grid flex-1 place-items-center">
      {transcript ? <div className="grid w-full max-w-2xl gap-3">
        <div className="flex flex-wrap items-center gap-1.5"><Badge variant="secondary">{transcript.sourceKind === "video" ? "视频" : "音频"} · {speechModels.find((item) => item.id === transcript.model)?.label ?? transcript.model}</Badge><Badge variant="secondary">{transcript.language === "auto" ? "自动检测" : transcript.language === "zh" ? "中文" : "英文"}</Badge><Badge variant="secondary">{transcript.duration.toFixed(1)} 秒</Badge><Badge variant="secondary">{transcript.segments.length} 段</Badge>{transcript.savedAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />已保存</Badge> : <Badge variant="outline">私有</Badge>}</div>
        {transcript.audioURL && <audio className="w-full" controls preload="metadata" src={transcript.audioURL} aria-label="转写源声音" />}
        <div className="max-h-[340px] overflow-auto rounded-md border">{transcript.segments.map((segment, index) => <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center gap-3 border-b px-3 py-1.5 last:border-0" key={`${transcript.id}-${index}`}><span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">{formatTimecode(segment.start).replace(",", " ").slice(0, 8)} → {formatTimecode(segment.end).replace(",", " ").slice(0, 8)}</span><Input aria-label={`第 ${index + 1} 段文本`} className="h-8 border-transparent bg-transparent shadow-none hover:border-border focus-visible:bg-background" onChange={(event) => onEditSegment(index, event.target.value)} value={segment.text} /></div>)}</div>
        <div className="flex items-center justify-between gap-3"><Button onClick={() => setShowSRT((visible) => !visible)} type="button" variant="ghost" size="sm" className="w-fit px-0 text-primary hover:bg-transparent hover:text-primary"><FileAudio className="size-3.5" />{showSRT ? "收起 SRT" : "预览 SRT"}</Button><p className="text-[11px] text-muted-foreground">文本可编辑，复制或下载会使用编辑后的内容。</p></div>
        {showSRT && <pre className="max-h-52 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{srt}</pre>}
        <div className="flex items-center justify-between gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">确认无误后保存为素材库的转写素材（含源声音、SRT 与 JSON）。</p>{transcript.savedAssetId ? <Badge variant="secondary">素材库已保存</Badge> : <Button disabled={busy !== null} onClick={() => onSave(transcript)} type="button" size="sm">{busy === "save" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}保存到素材库</Button>}</div>
      </div> : <div className="grid max-w-60 place-items-center gap-2 text-center text-sm text-muted-foreground"><MessageSquareText className="size-7 text-muted-foreground/60" /><p>选择素材并转写后，文稿与字幕会显示在这里。</p></div>}
    </div>
  </CardContent>;
}

function CharactersOutput({ busy, characters, onRemove, onSave }: { busy: string | null; characters: VoiceCharacter[]; onRemove: (character: VoiceCharacter) => void; onSave: (character: VoiceCharacter) => void }) {
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between border-b pb-3"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">声音角色</p><h2 className="mt-0.5 text-sm font-semibold">可复用角色库</h2></div><Badge variant="secondary">{characters.length} 个</Badge></div>
    <div className="grid flex-1 content-start gap-3 overflow-auto">
      {characters.length ? characters.map((character) => <Card className="rounded-lg shadow-none" key={character.id}><CardHeader className="pb-2"><div className="flex items-center justify-between"><CardTitle className="text-sm">{character.name}</CardTitle>{character.sampleAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />已保存</Badge> : <Badge variant="outline">私有</Badge>}</div><CardDescription className="truncate text-[11px]">参考转写：{character.model.replace("whisper-", "")}</CardDescription></CardHeader><CardContent className="grid gap-2"><audio className="w-full" controls preload="metadata" src={character.sampleURL} /><p className="truncate text-[11px] text-muted-foreground" title={character.promptText}>提示词：{character.promptText || "（尚未生成）"}</p></CardContent><CardFooter className="justify-between gap-2"><Button disabled={busy !== null} onClick={() => onSave(character)} type="button" variant="outline" size="sm"><Save className="size-3.5" />保存参考音</Button><Button disabled={busy !== null} onClick={() => onRemove(character)} type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive"><Trash2 className="size-3.5" />删除</Button></CardFooter></Card>) : <div className="grid place-items-center gap-2 py-16 text-center text-sm text-muted-foreground"><Mic className="size-7 text-muted-foreground/60" /><p>用一段参考人声创建声音角色，之后就能让它朗读任何文本。</p></div>}
    </div>
  </CardContent>;
}

function SynthesisOutput({ busy, selected, syntheses, onSave }: { busy: string | null; selected: Synthesis | null; syntheses: Synthesis[]; onSave: (synthesis: Synthesis) => void }) {
  const current = selected ?? syntheses[0] ?? null;
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between border-b pb-3"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">配音</p><h2 className="mt-0.5 text-sm font-semibold">合成预览</h2></div>{current && (current.savedAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />已保存</Badge> : <Badge variant="outline">私有预览</Badge>)}</div>
    <div className="grid flex-1 place-items-center">
      {current ? <div className="grid w-full max-w-md gap-3"><div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"><div className="grid gap-0.5"><strong className="text-xs font-medium">当前配音</strong><small className="text-[11px] text-muted-foreground">{styles.find((item) => item.id === current.style)?.label ?? current.style} · {current.duration.toFixed(1)} 秒 · {timestamp(current.createdAt)}</small></div>{current.savedAssetId ? <Check className="size-4 text-primary" /> : null}</div><audio className="w-full" controls src={current.outputURL} /></div> : <div className="grid max-w-60 place-items-center gap-2 text-center text-sm text-muted-foreground"><Sparkles className="size-7 text-muted-foreground/60" /><p>选择声音角色并输入文本后，配音会显示在这里。</p></div>}
    </div>
    {current && <div className="flex items-center justify-between gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">试听满意后再决定是否保存到素材库。</p>{current.savedAssetId ? <Badge variant="secondary">素材库已保存</Badge> : <Button disabled={busy !== null} onClick={() => onSave(current)} type="button" size="sm">{busy === "save" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}保存到素材库</Button>}</div>}
  </CardContent>;
}

function BottomPanel({ activeTab, cancelling, elapsedSeconds, logs, onCancel, onTabChange, running, tab, transcripts, characters, syntheses }: { activeTab: "history" | "logs"; cancelling: boolean; elapsedSeconds: number; logs: ShellJobLog[]; onCancel: () => void; onTabChange: (tab: "history" | "logs") => void; running: boolean; tab: Tab; transcripts: TranscriptSummary[]; characters: VoiceCharacter[]; syntheses: Synthesis[] }) {
  const historyCount = tab === "transcribe" ? transcripts.length : tab === "characters" ? characters.length : syntheses.length;
  return <Card className="mt-4 rounded-lg shadow-none">
    <div className="flex items-center gap-1 border-b bg-muted/30 px-3 py-2" role="tablist" aria-label="输出记录">
      <Button aria-controls="audio-history" aria-selected={activeTab === "history"} className={cn("h-8 rounded-md px-3 text-muted-foreground hover:bg-background hover:text-foreground", activeTab === "history" && "bg-background text-foreground shadow-sm ring-1 ring-foreground/10 hover:bg-background")} id="audio-history-tab" onClick={() => onTabChange("history")} role="tab" type="button" variant="ghost" size="sm">历史 <Badge variant="secondary" className="ml-1">{historyCount}</Badge></Button>
      <Button aria-controls="audio-logs" aria-selected={activeTab === "logs"} className={cn("h-8 rounded-md px-3 text-muted-foreground hover:bg-background hover:text-foreground", activeTab === "logs" && "bg-background text-foreground shadow-sm ring-1 ring-foreground/10 hover:bg-background")} id="audio-logs-tab" onClick={() => onTabChange("logs")} role="tab" type="button" variant="ghost" size="sm">执行日志 <Badge variant="secondary" className="ml-1">{logs.length}</Badge></Button>
      {running && <Button className="ml-auto text-destructive hover:text-destructive" disabled={cancelling} onClick={onCancel} type="button" variant="ghost" size="sm"><CircleStop className="size-3.5" />{cancelling ? "正在停止" : "停止任务"}</Button>}
    </div>
    <div className="min-h-40">
      {activeTab === "history" ? <div aria-labelledby="audio-history-tab" id="audio-history" role="tabpanel"><History tab={tab} transcripts={transcripts} characters={characters} syntheses={syntheses} /></div> : <div aria-labelledby="audio-logs-tab" className="min-h-40 bg-terminal text-terminal-fg" id="audio-logs" role="tabpanel">{running && <p className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3 font-mono text-[11px] font-semibold text-primary"><Clock3 className="size-3.5" />任务运行中 · {formatElapsed(elapsedSeconds)}</p>}<pre className="max-h-56 overflow-auto p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{logs.length ? logText(logs) : "正在等待任务输出…"}</pre></div>}
    </div>
  </Card>;
}

function History({ tab, transcripts, characters, syntheses }: { tab: Tab; transcripts: TranscriptSummary[]; characters: VoiceCharacter[]; syntheses: Synthesis[] }) {
  const items = tab === "transcribe" ? transcripts.map((item) => ({ key: item.id, title: item.sourceKind === "video" ? "视频转写" : "音频转写", note: `${speechModels.find((m) => m.id === item.model)?.label ?? item.model} · ${item.language === "auto" ? "自动" : item.language} · ${item.duration.toFixed(1)}s`, at: timestamp(item.createdAt) }))
    : tab === "characters" ? characters.map((item) => ({ key: item.id, title: item.name, note: item.promptText ? `提示词已就绪 · ${item.promptText.length} 字` : "提示词未生成", at: timestamp(item.createdAt) }))
    : syntheses.map((item) => ({ key: item.id, title: styles.find((s) => s.id === item.style)?.label ?? item.style, note: item.text.slice(0, 36) + (item.text.length > 36 ? "…" : ""), at: timestamp(item.createdAt) }));
  return <div aria-labelledby="audio-history-tab" id="audio-history" role="tabpanel"><div className="flex items-center justify-between border-b px-4 py-2.5"><h3 className="text-sm font-semibold">全部输出</h3><span className="font-mono text-[11px] text-muted-foreground">{items.length} 条</span></div>{items.length ? <ul className="divide-y">{items.map((item) => <li className="flex items-center justify-between gap-3 px-4 py-2" key={item.key}><div className="grid min-w-0 gap-0.5"><strong className="truncate text-xs">{item.title}</strong><span className="truncate text-[11px] text-muted-foreground">{item.note}</span></div><span className="font-mono text-[10px] text-muted-foreground">{item.at}</span></li>)}</ul> : <p className="px-4 py-4 text-xs text-muted-foreground">还没有历史输出。</p>}</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
