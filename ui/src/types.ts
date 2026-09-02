/**
 * [INPUT]: 依赖声音工坊 App operation 与素材库 HTTP 返回的稳定 JSON，含 audio.presets 的本地化文本对象
 * [OUTPUT]: 对外提供运行状态（含 engines 双引擎就绪与运行环境错误、声音预设缓存状态、在途任务清单 tasks）、下载源、素材、Whisper/Qwen 转写（含源声音与素材库保存状态）、带来源 origin 的角色与合成输出的 UI 类型；任务摘要含排队/运行状态与 shell 任务 id（TaskSummary）；TTS 支持 CosyVoice 与 VoxCPM 引擎
 * [POS]: ui/src 的领域契约；组件不重复解释后端记录字段，也不直接渲染未解析的本地化对象
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
export type LocalizedText = string | { zh?: string; en?: string };
export type SpeechModel = "whisper-small" | "whisper-medium" | "whisper-large-v3" | "qwen3-asr-0.6b" | "qwen3-asr-1.7b";
export type DownloadSource = "automatic" | "huggingface" | "modelscope";
export type SourceKind = "audio" | "video";
export type Language = "auto" | "zh" | "en";
export type VoiceStyle = "neutral" | "calm" | "excited" | "gentle";
export type VoxCpmVersion = "voxcpm2" | "voxcpm1.5" | "voxcpm-0.5b";
export type TtsEngine = "cosyvoice2" | VoxCpmVersion;
export type ShellJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ShellJobLog = { jobId: string; sequence: number; text: string };
export type ShellJob = { id: string; status: ShellJobStatus; error?: string; startedAt?: string };
export type ActiveAudioJob = ShellJob & { action: "prepare" | "install" | "transcribe" | "character" | "design" | "synthesize"; recordID?: string; startedAt: string; logs: ShellJobLog[] };
export type VoxCpmModelStatus = { label: string; params: string; sampleRate: number; languages: number; sizeGb: number; downloaded: boolean; ready: boolean };
export type VoxCpmEngineStatus = { runtime: boolean; runtimeError?: string | null; models: Record<VoxCpmVersion, VoxCpmModelStatus>; ready: boolean };
export type VoiceOrigin = "clone" | "design" | "preset";
export type RuntimeStatus = { ready: boolean; pending?: boolean; modelsRoot: string; error?: string; pythonVersion?: string; downloadSource?: DownloadSource; asr: { installed: SpeechModel[]; qwenAligner?: boolean }; tts: { ready: boolean; repository?: boolean; model?: boolean; verification?: boolean; engines?: { cosyvoice2?: { repository?: boolean; model?: boolean; runtime?: boolean; runtimeError?: string | null; ready?: boolean }; voxcpm?: VoxCpmEngineStatus } }; presets?: { cdnReachable: boolean; cached: string[] }; activeJob?: ActiveAudioJob | null; tasks?: TaskSummary[]; setupError?: string; setupLogs?: ShellJobLog[] };
export type MediaAsset = { id: string; name: string; kind: SourceKind | string; mimeType: string; status: string };
export type TranscriptSegment = { start: number; end: number; text: string; speaker: string; emotion: string };
export type TranscriptSummary = { id: string; sourceAssetId: string; sourceKind: SourceKind; model: SpeechModel; language: string; duration: number; createdAt: string; srtURL: string; jsonURL: string; audioURL: string; savedAssetId: string };
export type TranscriptDetail = TranscriptSummary & { segments: TranscriptSegment[]; srt: string; status?: string; error?: string };
export type VoiceCharacter = { id: string; name: string; model: SpeechModel; promptText: string; sampleAssetId: string; origin: VoiceOrigin; createdAt: string; sampleURL: string };
export type Synthesis = { id: string; characterId: string; text: string; style: VoiceStyle; engine: TtsEngine; savedAssetId: string; createdAt: string; outputURL: string; duration: number };

// ---- 声音预设与 Voice Design（见 rfc/2026-09-02-voice-presets-and-voice-design.md）----
export type VoiceScene = "general" | "narration" | "emotion" | "suspense" | "kids" | "commerce" | "dialect" | "podcast";
// previewURL 为可选私有预览地址：audio.presets 不返回该字段；试听经 audio.preset.prepare 按需准备后返回。
export type VoicePreset = { id: string; name: LocalizedText; scene: VoiceScene | string; blurb: LocalizedText; designDesc: string; version: string; source: "manifest" | "bootstrap"; cached: boolean; cachedBytes?: number; previewURL?: string };
export type PresetsResult = { presets: VoicePreset[] };
export type DesignCharacterResult = { job: ShellJob | null; taskId: string; character: { id: string } };
export type DesignCharacterInput = { name: string; designDesc?: string; presetId?: string; model?: SpeechModel; saveToLibrary?: boolean };

// ---- 任务中心（v2 统一任务账本，见 rfc/2026-08-23-task-center-ux.md）----
export type TaskSource = "ai" | "manual";
export type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type TaskAction = "prepare" | "install" | "transcribe" | "character" | "design" | "synthesize";
export type TaskMeta = {
  type?: string;
  engine?: string;
  model?: string;
  language?: string;
  characterId?: string;
  characterName?: string;
  sourceAssetId?: string;
  sourceKind?: string;
  presetId?: string;
  designDesc?: string;
  sizeGb?: number | null;
  durationSec?: number | null;
  [key: string]: unknown;
};
export type TaskSummary = {
  id: string;
  action: TaskAction;
  name: string;
  recordId: string;
  source: TaskSource;
  submittedBy: string;
  state: TaskState;
  progress: number;
  createdAt: string;
  startedAt?: string;
  jobId?: string;
  error?: string;
  meta: TaskMeta;
};
export type TaskLogEntry = { index: number; ts: string; level: "info" | "warn" | "error" | "ok"; message: string };
export type TaskListResult = { tasks: TaskSummary[]; nextCursor: string | null };
export type TaskLogResult = { logs: TaskLogEntry[]; nextCursor: number | null };
