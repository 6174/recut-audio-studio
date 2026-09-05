/**
 * [INPUT]: 依赖 zustand、types（各领域类型）与 lib/options（Tab/EngineFamily/ActiveJob/SynthesisDraft）
 * [OUTPUT]: useAppStore：audio-studio 的全局状态容器（zustand），按分区组织——运行时（status/characters/syntheses/assets/预设）、来源与表单（转写源/克隆表单/配音草稿）、任务（busy/message/activeJob/logs/云端配音）、任务中心（tasks/selectedTask/taskLogs/taskResult）；只放状态与简单 setter，业务动作在 ./actions
 * [POS]: main.tsx 的 App 从组件 useState 迁移为订阅本 store；actions.ts 经 useAppStore.getState()/setState() 读写
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { create } from "zustand";
import type { Locale } from "../recut-sdk";
import type { ActiveAudioJob, CloudVoiceSelection, DownloadSource, Language, MediaAsset, RuntimeStatus, ShellJobLog, SpeechModel, Synthesis, TaskAction, TaskLogEntry, TaskSummary, TranscriptDetail, VoiceCharacter, VoicePreset, VoiceStyle, VoxCpmVersion } from "../types";
import { type ActiveJob, type EngineFamily, type Tab } from "../lib/options";

export type TaskFilter = "all" | "running" | "queued" | "completed" | "failed";

export type BusyAction = "prepare" | "install" | "transcribe" | "character" | "design" | "synthesize" | "save" | "upload" | "agent" | null;
export type CharactersView = "entries" | "clone" | "design" | "manage";
export type SettingsFocus = "environment" | "asr" | "tts";
export type TaskResult = { kind: "transcript" | "character" | "synthesis"; item: TranscriptDetail | VoiceCharacter | Synthesis } | null;
export type { ActiveAudioJob, TaskAction };

export type AppStore = {
  // locale（actions 里的 i18n 依赖）
  locale: Locale;
  setLocale: (locale: Locale) => void;
  // 运行时数据
  status: RuntimeStatus | null;
  setStatus: (status: RuntimeStatus | null) => void;
  characters: VoiceCharacter[];
  setCharacters: (updater: (items: VoiceCharacter[]) => VoiceCharacter[]) => void;
  charactersLoading: boolean;
  setCharactersLoading: (loading: boolean) => void;
  syntheses: Synthesis[];
  setSyntheses: (updater: (items: Synthesis[]) => Synthesis[]) => void;
  assets: MediaAsset[];
  setAssets: (updater: (items: MediaAsset[]) => MediaAsset[]) => void;
  presets: VoicePreset[];
  setPresets: (presets: VoicePreset[]) => void;
  presetsError: string;
  setPresetsError: (error: string) => void;
  preparingPresetId: string;
  setPreparingPresetId: (id: string) => void;
  playingPresetId: string;
  setPlayingPresetId: (id: string | ((current: string) => string)) => void;
  // 转写来源与模型选择
  tab: Tab;
  setTab: (tab: Tab) => void;
  sourceKind: "audio" | "video";
  setSourceKind: (kind: "audio" | "video") => void;
  assetId: string;
  setAssetId: (id: string) => void;
  selectedAsset: MediaAsset | null;
  setSelectedAsset: (asset: MediaAsset | null) => void;
  model: SpeechModel;
  setModel: (model: SpeechModel) => void;
  downloadSource: DownloadSource;
  setDownloadSource: (source: DownloadSource) => void;
  language: Language;
  setLanguage: (language: Language) => void;
  // 克隆表单
  characterName: string;
  setCharacterName: (name: string) => void;
  characterAssetId: string;
  setCharacterAssetId: (id: string) => void;
  characterAsset: MediaAsset | null;
  setCharacterAsset: (asset: MediaAsset | null) => void;
  // 配音表单（会话级草稿）
  synthesisText: string;
  setSynthesisText: (text: string) => void;
  synthesisCharacterId: string;
  setSynthesisCharacterId: (id: string) => void;
  synthesisPresetId: string;
  setSynthesisPresetId: (id: string) => void;
  synthesisCloud: CloudVoiceSelection | null;
  setSynthesisCloud: (cloud: CloudVoiceSelection | null) => void;
  style: VoiceStyle;
  setStyle: (style: VoiceStyle) => void;
  engine: EngineFamily;
  setEngine: (engine: EngineFamily) => void;
  voxcpmVersion: VoxCpmVersion;
  setVoxcpmVersion: (version: VoxCpmVersion) => void;
  // 任务执行态
  busy: BusyAction;
  setBusy: (busy: BusyAction) => void;
  message: string;
  setMessage: (message: string) => void;
  failure: string;
  setFailure: (failure: string) => void;
  activeJob: ActiveJob | null;
  setActiveJob: (updater: (current: ActiveJob | null) => ActiveJob | null) => void;
  logs: ShellJobLog[];
  setLogs: (updater: ShellJobLog[] | ((current: ShellJobLog[]) => ShellJobLog[])) => void;
  elapsedSeconds: number;
  setElapsedSeconds: (seconds: number) => void;
  cloudJob: { id: string; name: string } | null;
  setCloudJob: (job: { id: string; name: string } | null) => void;
  cloudBusy: boolean;
  setCloudBusy: (busy: boolean) => void;
  cloudResult: { url: string; name: string } | null;
  setCloudResult: (result: { url: string; name: string } | null) => void;
  // 任务中心
  tasks: TaskSummary[];
  setTasks: (tasks: TaskSummary[]) => void;
  selectedTask: TaskSummary | null;
  setSelectedTask: (updater: TaskSummary | null | ((current: TaskSummary | null) => TaskSummary | null)) => void;
  taskLogs: TaskLogEntry[];
  setTaskLogs: (logs: TaskLogEntry[]) => void;
  taskFilter: TaskFilter;
  setTaskFilter: (filter: TaskFilter) => void;
  taskResult: TaskResult;
  setTaskResult: (updater: (current: TaskResult) => TaskResult) => void;
  activeTasks: TaskSummary[];
  setActiveTasks: (tasks: TaskSummary[]) => void;
  // UI 编排
  launcherOpen: Tab | null;
  setLauncherOpen: (tab: Tab | null) => void;
  workflowStep: number;
  setWorkflowStep: (updater: (current: number) => number) => void;
  charactersView: CharactersView;
  setCharactersView: (view: CharactersView) => void;
  viewCharacter: VoiceCharacter | null;
  setViewCharacter: (character: VoiceCharacter | null) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsFocus: SettingsFocus;
  setSettingsFocus: (focus: SettingsFocus) => void;
};

export const useAppStore = create<AppStore>()((set) => ({
  locale: "zh",
  setLocale: (locale) => set({ locale }),
  status: null,
  setStatus: (status) => set({ status }),
  characters: [],
  setCharacters: (updater) => set((state) => ({ characters: updater(state.characters) })),
  charactersLoading: true,
  setCharactersLoading: (charactersLoading) => set({ charactersLoading }),
  syntheses: [],
  setSyntheses: (updater) => set((state) => ({ syntheses: updater(state.syntheses) })),
  assets: [],
  setAssets: (updater) => set((state) => ({ assets: updater(state.assets) })),
  presets: [],
  setPresets: (presets) => set({ presets }),
  presetsError: "",
  setPresetsError: (presetsError) => set({ presetsError }),
  preparingPresetId: "",
  setPreparingPresetId: (preparingPresetId) => set({ preparingPresetId }),
  playingPresetId: "",
  setPlayingPresetId: (id) => set((state) => ({ playingPresetId: typeof id === "function" ? id(state.playingPresetId) : id })),
  tab: "transcribe",
  setTab: (tab) => set({ tab }),
  sourceKind: "audio",
  setSourceKind: (sourceKind) => set({ sourceKind }),
  assetId: "",
  setAssetId: (assetId) => set({ assetId }),
  selectedAsset: null,
  setSelectedAsset: (selectedAsset) => set({ selectedAsset }),
  model: "qwen3-asr-0.6b",
  setModel: (model) => set({ model }),
  downloadSource: "automatic",
  setDownloadSource: (downloadSource) => set({ downloadSource }),
  language: "auto",
  setLanguage: (language) => set({ language }),
  characterName: "",
  setCharacterName: (characterName) => set({ characterName }),
  characterAssetId: "",
  setCharacterAssetId: (characterAssetId) => set({ characterAssetId }),
  characterAsset: null,
  setCharacterAsset: (characterAsset) => set({ characterAsset }),
  synthesisText: "",
  setSynthesisText: (synthesisText) => set({ synthesisText }),
  synthesisCharacterId: "",
  setSynthesisCharacterId: (synthesisCharacterId) => set({ synthesisCharacterId }),
  synthesisPresetId: "",
  setSynthesisPresetId: (synthesisPresetId) => set({ synthesisPresetId }),
  synthesisCloud: null,
  setSynthesisCloud: (synthesisCloud) => set({ synthesisCloud }),
  style: "neutral",
  setStyle: (style) => set({ style }),
  engine: "cosyvoice2",
  setEngine: (engine) => set({ engine }),
  voxcpmVersion: "voxcpm2",
  setVoxcpmVersion: (voxcpmVersion) => set({ voxcpmVersion }),
  busy: null,
  setBusy: (busy) => set({ busy }),
  message: "",
  setMessage: (message) => set({ message }),
  failure: "",
  setFailure: (failure) => set({ failure }),
  activeJob: null,
  setActiveJob: (updater) => set((state) => ({ activeJob: updater(state.activeJob) })),
  logs: [],
  setLogs: (updater) => set((state) => ({ logs: typeof updater === "function" ? updater(state.logs) : updater })),
  elapsedSeconds: 0,
  setElapsedSeconds: (elapsedSeconds) => set({ elapsedSeconds }),
  cloudJob: null,
  setCloudJob: (cloudJob) => set({ cloudJob }),
  cloudBusy: false,
  setCloudBusy: (cloudBusy) => set({ cloudBusy }),
  cloudResult: null,
  setCloudResult: (cloudResult) => set({ cloudResult }),
  tasks: [],
  setTasks: (tasks) => set({ tasks }),
  selectedTask: null,
  setSelectedTask: (updater) => set((state) => ({ selectedTask: typeof updater === "function" ? updater(state.selectedTask) : updater })),
  taskLogs: [],
  setTaskLogs: (taskLogs) => set({ taskLogs }),
  taskFilter: "all",
  setTaskFilter: (taskFilter) => set({ taskFilter }),
  taskResult: null,
  setTaskResult: (updater) => set((state) => ({ taskResult: updater(state.taskResult) })),
  activeTasks: [],
  setActiveTasks: (activeTasks) => set({ activeTasks }),
  launcherOpen: null,
  setLauncherOpen: (launcherOpen) => set({ launcherOpen }),
  workflowStep: 0,
  setWorkflowStep: (updater) => set((state) => ({ workflowStep: Math.max(0, updater(state.workflowStep)) })),
  charactersView: "entries",
  setCharactersView: (charactersView) => set({ charactersView }),
  viewCharacter: null,
  setViewCharacter: (viewCharacter) => set({ viewCharacter }),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  settingsFocus: "environment",
  setSettingsFocus: (settingsFocus) => set({ settingsFocus }),
}));
