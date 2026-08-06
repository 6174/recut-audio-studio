/**
 * [INPUT]: 依赖声音工坊 App operation 与素材库 HTTP 返回的稳定 JSON
 * [OUTPUT]: 对外提供运行状态、下载源、素材、Whisper/Qwen 转写、角色与合成输出的 UI 类型
 * [POS]: ui/src 的领域契约；组件不重复解释后端记录字段
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
export type SpeechModel = "whisper-small" | "whisper-medium" | "whisper-large-v3" | "qwen3-asr-0.6b" | "qwen3-asr-1.7b";
export type DownloadSource = "automatic" | "huggingface" | "modelscope";
export type SourceKind = "audio" | "video";
export type Language = "auto" | "zh" | "en";
export type VoiceStyle = "neutral" | "calm" | "excited" | "gentle";
export type ShellJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ShellJobLog = { jobId: string; sequence: number; text: string };
export type ShellJob = { id: string; status: ShellJobStatus; error?: string; startedAt?: string };
export type ActiveAudioJob = ShellJob & { action: "prepare" | "install" | "transcribe" | "character" | "synthesize"; recordID?: string; startedAt: string; logs: ShellJobLog[] };
export type RuntimeStatus = { ready: boolean; pending?: boolean; modelsRoot: string; error?: string; downloadSource?: DownloadSource; asr: { installed: SpeechModel[]; qwenAligner?: boolean }; tts: { ready: boolean; repository?: boolean; model?: boolean }; activeJob?: ActiveAudioJob | null; setupError?: string; setupLogs?: ShellJobLog[] };
export type MediaAsset = { id: string; name: string; kind: SourceKind | string; mimeType: string; status: string };
export type TranscriptSegment = { start: number; end: number; text: string; speaker: string; emotion: string };
export type TranscriptSummary = { id: string; sourceAssetId: string; sourceKind: SourceKind; model: SpeechModel; language: string; duration: number; createdAt: string; srtURL: string; jsonURL: string };
export type TranscriptDetail = TranscriptSummary & { segments: TranscriptSegment[]; srt: string; status?: string; error?: string };
export type VoiceCharacter = { id: string; name: string; model: SpeechModel; promptText: string; sampleAssetId: string; createdAt: string; sampleURL: string };
export type Synthesis = { id: string; characterId: string; text: string; style: VoiceStyle; savedAssetId: string; createdAt: string; outputURL: string; duration: number };
