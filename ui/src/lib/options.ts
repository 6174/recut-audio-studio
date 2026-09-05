/**
 * [INPUT]: 依赖 i18n 与 types（模型/引擎/风格等枚举类型）
 * [OUTPUT]: 选项常量（ASR 模型 / 下载源 / 语言 / 配音风格 / TTS 引擎族 / VoxCPM 版本）与派生标签函数（engineLabel/styleLabel），以及会话级配音草稿（SynthesisDraft 类型 + sessionStorage 读写）
 * [POS]: audio-studio UI 的共享选项层；App 与各控件组件统一从这里取枚举与标签，避免散落副本
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import type { Locale } from "../recut-sdk";
import type { ActiveAudioJob, CloudVoiceSelection, DownloadSource, Language, ShellJob, SpeechModel, VoiceStyle, VoxCpmVersion } from "../types";
import { t, type I18nKey } from "../i18n";

export type Tab = "transcribe" | "characters" | "synthesize";
export type EngineFamily = "cosyvoice2" | "voxcpm";

export const speechModels: { id: SpeechModel; label: string; noteKey: I18nKey }[] = [
  { id: "qwen3-asr-0.6b", label: "Qwen3 ASR 0.6B", noteKey: "model.qwen3-0.6b.note" },
  { id: "qwen3-asr-1.7b", label: "Qwen3 ASR 1.7B", noteKey: "model.qwen3-1.7b.note" },
  { id: "whisper-small", label: "Whisper Small", noteKey: "model.whisper-small.note" },
  { id: "whisper-medium", label: "Whisper Medium", noteKey: "model.whisper-medium.note" },
  { id: "whisper-large-v3", label: "Whisper Large-v3", noteKey: "model.whisper-large-v3.note" },
];

export const downloadSources: { id: DownloadSource; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "automatic", labelKey: "downloadSource.automatic", noteKey: "downloadSource.automatic.note" },
  { id: "huggingface", labelKey: "downloadSource.huggingface", noteKey: "downloadSource.huggingface.note" },
  { id: "modelscope", labelKey: "downloadSource.modelscope", noteKey: "downloadSource.modelscope.note" },
];

export const languages: { id: Language; labelKey: I18nKey }[] = [
  { id: "auto", labelKey: "language.auto" },
  { id: "zh", labelKey: "language.zh" },
  { id: "en", labelKey: "language.en" },
];

export const styles: { id: VoiceStyle; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "neutral", labelKey: "style.neutral", noteKey: "style.neutral.note" },
  { id: "calm", labelKey: "style.calm", noteKey: "style.calm.note" },
  { id: "excited", labelKey: "style.excited", noteKey: "style.excited.note" },
  { id: "gentle", labelKey: "style.gentle", noteKey: "style.gentle.note" },
];

export const engines: { id: EngineFamily; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "cosyvoice2", labelKey: "engine.cosyvoice.label", noteKey: "engine.cosyvoice.note" },
  { id: "voxcpm", labelKey: "engine.voxcpm.label", noteKey: "engine.voxcpm.note" },
];

export const voxcpmVersions: { id: VoxCpmVersion; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "voxcpm2", labelKey: "engine.label.voxcpm2", noteKey: "voxcpm.voxcpm2.note" },
  { id: "voxcpm1.5", labelKey: "engine.label.voxcpm1.5", noteKey: "voxcpm.voxcpm1.5.note" },
  { id: "voxcpm-0.5b", labelKey: "engine.label.voxcpm-0.5b", noteKey: "voxcpm.voxcpm-0.5b.note" },
];

export function engineLabel(locale: Locale, engine: string): string {
  const item = engines.find((entry) => entry.id === engine) ?? voxcpmVersions.find((entry) => entry.id === engine);
  return item ? t(locale, item.labelKey) : engine;
}

export function styleLabel(locale: Locale, style: string) { const item = styles.find((entry) => entry.id === style); return item ? t(locale, item.labelKey) : style; }

export type ActiveJob = { id: string; action: ActiveAudioJob["action"]; recordID?: string; startedAt: number; status: ShellJob["status"]; error?: string };
export type SynthesisDraft = { text: string; characterId: string; presetId: string; cloud: CloudVoiceSelection | null; style: VoiceStyle; engine: EngineFamily; voxcpmVersion: VoxCpmVersion };

const synthesisDraftStorageKey = "recut.audio-studio.synthesis-draft.v1";

export function readSynthesisDraft(): SynthesisDraft {
  try {
    const draft = JSON.parse(window.sessionStorage.getItem(synthesisDraftStorageKey) || "{}") as Partial<SynthesisDraft>;
    return {
      text: typeof draft.text === "string" ? draft.text : "",
      characterId: typeof draft.characterId === "string" ? draft.characterId : "",
      presetId: typeof draft.presetId === "string" ? draft.presetId : "",
      cloud: draft.cloud && typeof draft.cloud === "object" && typeof draft.cloud.credentialId === "string" && typeof draft.cloud.voiceId === "string" ? draft.cloud : null,
      style: draft.style && styles.some((item) => item.id === draft.style) ? draft.style : "neutral",
      engine: draft.engine && engines.some((item) => item.id === draft.engine) ? draft.engine : "cosyvoice2",
      voxcpmVersion: draft.voxcpmVersion && voxcpmVersions.some((item) => item.id === draft.voxcpmVersion) ? draft.voxcpmVersion : "voxcpm2",
    };
  } catch (_) { return { text: "", characterId: "", presetId: "", cloud: null, style: "neutral", engine: "cosyvoice2", voxcpmVersion: "voxcpm2" }; }
}

export function saveSynthesisDraft(draft: SynthesisDraft) {
  try { window.sessionStorage.setItem(synthesisDraftStorageKey, JSON.stringify(draft)); }
  catch (_) { /* 浏览器禁止会话存储时，仍保留当前页面内的 React 状态。 */ }
}
