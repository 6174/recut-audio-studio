/**
 * [INPUT]: 依赖 i18n、types、shadcn/ui 组件与 lucide 图标；audio.presets 可能返回 {zh,en} 本地化对象；平台 /v1/media/capabilities/speech.generate/voices 聚合分组与 /v1/media/credentials/{id}/voices/{voiceId}/preview 试听解析
 * [OUTPUT]: 页签式声音选择器（预设 / 我的角色，预设页签按场景分组，试听经 audio.preset.prepare 按需后台下载后播放）、「设计声音」弹框（名称 + 音色描述 + 从预设起步 + 保存到素材库），以及配音两步工作流 DubbingControls：声音分组改为多页签（本机一个页签 = 默认音/预设/角色，组头经 ModelPickerPopover（复用全局设置 ModelPicker 的双栏体验：候选列表+悬停详情卡+未就绪设置入口）扁平选择本地模型；云端每凭据一个页签，页签内选语音模型——模型选择独立于音色选择，未选音色也能换模型，换模型后默认声音角色随模型切换（新模型首个音色成为默认选中，无音色模型清空选择），默认模型取首个有音色模型；未连接组给设置引导），分组加载与角色加载均用 skeleton 占位；页签下方为文本提交；云端 voice 试听优先用 provider 原生 previewUrl，否则经平台懒生成预览端点轮询媒体任务
 * [POS]: audio-studio Phase 2 的预设选择、Voice Design 与配音重构 UI；预设名称/blurb 来自 op 返回值，需先折叠为当前 locale 字符串
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Pause, Play, RefreshCw, Search, Settings, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useRecutLocale, type Locale } from "./recut-sdk";
import type { CloudVoiceSelection, LocalizedText, PlatformVoiceGroup, RuntimeStatus, TtsEngine, VoiceCharacter, VoicePreset, VoiceScene, VoiceStyle, VoxCpmEngineStatus } from "./types";
import { t, tF, type I18nKey } from "./i18n";

const scenes: VoiceScene[] = ["general", "narration", "emotion", "suspense", "kids", "commerce", "dialect", "podcast"];
// 后端契约之外的 scene 值一律归入 general（RFC §2 D6）。
function normalizeScene(scene: string): VoiceScene { return (scenes as string[]).includes(scene) ? scene as VoiceScene : "general"; }
function formatBytes(bytes: number): string { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function localizedText(locale: Locale, value: LocalizedText): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const primary = locale === "en" ? value.en : value.zh;
  return primary || value.zh || value.en || "";
}

export function originLabelKey(origin: string): I18nKey {
  if (origin === "design") return "character.origin.design";
  if (origin === "preset") return "character.origin.preset";
  return "character.origin.clone";
}

export function VoicePicker({ busy, presets, presetsError, characters, showDefaultVoice, defaultVoiceLabelKey, selectedPresetId, selectedCharacterId, playingPresetId, preparingPresetId, onSelectPreset, onSelectCharacter, onPreviewPreset }: {
  busy: string | null;
  presets: VoicePreset[];
  presetsError: string;
  characters: VoiceCharacter[];
  showDefaultVoice: boolean;
  defaultVoiceLabelKey: I18nKey;
  selectedPresetId: string;
  selectedCharacterId: string;
  playingPresetId: string;
  preparingPresetId: string;
  onSelectPreset: (id: string) => void;
  onSelectCharacter: (id: string) => void;
  onPreviewPreset: (id: string) => void;
}) {
  const locale = useRecutLocale();
  const [tab, setTab] = useState<"presets" | "characters">("presets");
  const [scene, setScene] = useState<"all" | VoiceScene>("all");
  const visible = useMemo(() => presets.filter((preset) => scene === "all" || normalizeScene(preset.scene) === scene), [presets, scene]);
  const tabs: { id: "presets" | "characters"; labelKey: I18nKey }[] = [
    { id: "presets", labelKey: "voice.tabs.presets" },
    { id: "characters", labelKey: "voice.tabs.characters" },
  ];
  const sceneTabs: { id: "all" | VoiceScene; labelKey: I18nKey }[] = [
    { id: "all", labelKey: "voice.scene.all" },
    ...scenes.map((id) => ({ id, labelKey: `voice.scene.${id}` as I18nKey })),
  ];
  return <div className="grid gap-3">
    <div className="grid w-fit grid-cols-2 gap-1 rounded-full border border-border/70 bg-muted/40 p-1">
      {tabs.map((item) => <Button className={cn("rounded-full px-4", tab === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setTab(item.id)} type="button" variant="ghost" size="sm">{t(locale, item.labelKey)}</Button>)}
    </div>
    {tab === "presets" ? <>
      <div className="flex flex-wrap gap-1.5">
        {sceneTabs.map((item) => <Button className={cn("h-7 rounded-full px-3 text-[11px]", scene === item.id ? "border-primary bg-primary/10 text-primary hover:bg-primary/10" : "bg-transparent")} disabled={busy !== null} key={item.id} onClick={() => setScene(item.id)} type="button" variant="outline" size="sm">{t(locale, item.labelKey)}</Button>)}
      </div>
      {presetsError ? <p className="text-[11px] text-destructive">{presetsError}</p> : null}
      <div className="grid max-h-64 gap-2 overflow-auto pr-1">
        {visible.map((preset) => <PresetCard busy={busy} key={preset.id} locale={locale} onPlay={() => onPreviewPreset(preset.id)} onSelect={() => onSelectPreset(preset.id)} playing={playingPresetId === preset.id} preparing={preparingPresetId === preset.id} preset={preset} selected={selectedPresetId === preset.id} />)}
        {!visible.length && !presetsError ? <p className="py-6 text-center text-xs text-muted-foreground">{t(locale, "preset.empty")}</p> : null}
      </div>
    </> : <div className="grid max-h-64 gap-1.5 overflow-auto pr-1">
      {showDefaultVoice && <button aria-pressed={!selectedCharacterId && !selectedPresetId} className={cn("flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", !selectedCharacterId && !selectedPresetId ? "border-primary bg-primary/10" : "hover:bg-muted")} disabled={busy !== null} onClick={() => onSelectCharacter("")} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{t(locale, defaultVoiceLabelKey)}</strong></span>{!selectedCharacterId && !selectedPresetId && <Check className="size-3.5 shrink-0 text-primary" />}</button>}
      {characters.map((character) => <button aria-pressed={selectedCharacterId === character.id} className={cn("flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", selectedCharacterId === character.id ? "border-primary bg-primary/10" : "hover:bg-muted")} disabled={busy !== null} key={character.id} onClick={() => onSelectCharacter(character.id)} type="button"><span className="grid min-w-0 gap-0.5"><span className="flex min-w-0 items-center gap-1.5"><strong className="truncate font-medium">{character.name}</strong><small className="shrink-0 text-[10px] text-muted-foreground">{t(locale, originLabelKey(character.origin))}</small></span></span>{selectedCharacterId === character.id && <Check className="size-3.5 shrink-0 text-primary" />}</button>)}
    </div>}
  </div>;
}

function PresetCard({ preset, selected, busy, playing, preparing, onPlay, onSelect, locale }: { preset: VoicePreset; selected: boolean; busy: string | null; playing: boolean; preparing: boolean; onPlay: () => void; onSelect: () => void; locale: Locale }) {
  return <div className={cn("flex w-full items-start justify-between gap-2 rounded-xl border px-3 py-3 text-left text-xs transition-colors", selected ? "border-primary bg-primary/10 shadow-[0_0_0_1px_rgba(34,197,94,0.08)]" : "bg-card hover:border-foreground/25 hover:bg-card")}>
    <button aria-pressed={selected} className="grid min-w-0 flex-1 gap-1 text-left disabled:pointer-events-none disabled:opacity-50" disabled={busy !== null} onClick={onSelect} type="button">
      <span className="flex items-center gap-1.5"><strong className="truncate font-medium">{localizedText(locale, preset.name)}</strong>{preset.source === "bootstrap" ? <Badge className="shrink-0 px-1 py-0 text-[9px]" variant="outline">{t(locale, "preset.bootstrap")}</Badge> : null}</span>
      <small className="line-clamp-2 text-foreground/75">{localizedText(locale, preset.blurb)}</small>
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
        {preset.cached
          ? <Badge className="gap-1 px-1.5 py-0 text-[10px]" variant="secondary">{tF(locale, "preset.cached", { size: formatBytes(preset.cachedBytes ?? 0) })}</Badge>
          : null}
        {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
      </span>
    </button>
    <Button aria-label={t(locale, playing ? "preset.pause" : "preset.play")} disabled={busy !== null || preparing} onClick={onPlay} size="icon" title={preparing ? t(locale, "preset.preparing") : t(locale, playing ? "preset.pause" : "preset.play")} type="button" variant="ghost" className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground">{preparing ? <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</Button>
  </div>;
}

// 无遮罩设计面板：由角色二级模态框承载。
// 就绪门控按表单形态计算：从预设起步分支零推理（只需 ASR 回读模型）；自由描述分支需要 VoxCPM2。
export function DesignVoicePanel({ busy, onClose, presets, asrReady, voxcpm2Ready, onOpenSettings, onSubmit }: { busy: string | null; onClose: () => void; presets: VoicePreset[]; asrReady: boolean; voxcpm2Ready: boolean; onOpenSettings: () => void; onSubmit: (input: { name: string; designDesc?: string; presetId?: string; saveToLibrary: boolean }) => void }) {
  const locale = useRecutLocale();
  const [name, setName] = useState("");
  const [designDesc, setDesignDesc] = useState("");
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  const ready = asrReady && voxcpm2Ready;
  const missingHint = !asrReady ? t(locale, "design.missingAsr") : !voxcpm2Ready ? t(locale, "design.missingVoxcpm2") : "";
  const submit = () => {
    if (!name.trim() || !designDesc.trim()) return;
    onSubmit({ name: name.trim(), designDesc: designDesc.trim(), saveToLibrary });
  };
  return <div className="grid gap-4">
    <div className="grid gap-2">
      <Label className="text-xs text-muted-foreground" htmlFor="design-name">{t(locale, "character.name.label")}</Label>
      <Input id="design-name" disabled={busy !== null} onChange={(event) => setName(event.target.value)} placeholder={t(locale, "design.name.placeholder")} value={name} />
    </div>
    <div className="grid gap-2">
      <Label className="text-xs text-muted-foreground" htmlFor="design-desc">{t(locale, "design.desc.label")}</Label>
      <Textarea id="design-desc" disabled={busy !== null} maxLength={120} onChange={(event) => setDesignDesc(event.target.value)} placeholder={t(locale, "design.desc.placeholder")} rows={4} value={designDesc} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t(locale, "design.desc.hint")}</p>
        <span className={cn("shrink-0 font-mono text-[10px]", designDesc.length >= 120 ? "text-destructive" : "text-muted-foreground")}>{tF(locale, "design.charCount", { count: designDesc.length })}</span>
      </div>
    </div>
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">{t(locale, "design.fromPreset")}</Label>
      </div>
      <div className="grid max-h-52 grid-cols-2 gap-2 overflow-auto rounded-lg border border-border/60 p-2">
        {presets.map((preset) => {
          return (
            <button
              key={preset.id}
              className={cn("grid gap-1 rounded-xl border px-2.5 py-2.5 text-left text-xs transition-colors", designDesc.trim() === preset.designDesc ? "border-primary bg-primary/10" : "border-border/60 bg-card/50 hover:bg-muted/50")}
              disabled={busy !== null}
              onClick={() => setDesignDesc(preset.designDesc || "")}
              type="button"
            >
              <span className="flex items-center justify-between gap-1">
                <strong className="truncate text-[12px] font-medium">{localizedText(locale, preset.name)}</strong>
                {designDesc.trim() && designDesc.trim() === preset.designDesc ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
              </span>
              <small className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{localizedText(locale, preset.blurb)}</small>
            </button>
          );
        })}
        {!presets.length ? <p className="col-span-2 py-6 text-center text-xs text-muted-foreground">{t(locale, "preset.empty")}</p> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">{t(locale, "design.fromPreset.hint")}</p>
    </div>
    <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
      <input checked={saveToLibrary} className="size-3.5 accent-[var(--primary,currentColor)]" disabled={busy !== null} onChange={(event) => setSaveToLibrary(event.target.checked)} type="checkbox" />
      {t(locale, "design.saveToLibrary")}
    </label>
    {ready ? null : <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><strong className="text-amber-600">{missingHint}</strong><Button disabled={busy !== null} onClick={onOpenSettings} type="button" variant="outline" size="sm" className="w-fit">{t(locale, "settings.open")}</Button></div>}
    <div className="flex items-center justify-end gap-2 pt-1">
      <Button disabled={busy !== null} onClick={onClose} type="button" variant="ghost">{t(locale, "dialog.close")}</Button>
      <Button disabled={busy !== null || !ready || !name.trim() || !designDesc.trim()} onClick={submit} title={!ready && missingHint ? missingHint : !designDesc.trim() ? t(locale, "design.descRequired") : undefined} type="button">{busy === "character" || busy === "design" ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Wand2 className="size-4" />}{t(locale, "design.submit")}</Button>
    </div>
  </div>;
}

// ---- 配音两步工作流：按 provider 分组的声音选择 → 文本提交 ----

export type DubbingSelection = { characterId: string; presetId: string; cloud: CloudVoiceSelection | null };

// 本地模型是扁平选项：选中即同时确定引擎与权重，不再二级级联。
const localModels: { id: TtsEngine; labelKey: I18nKey; noteKey: I18nKey }[] = [
  { id: "cosyvoice2", labelKey: "engine.label.cosyvoice2", noteKey: "engine.cosyvoice.note" },
  { id: "voxcpm2", labelKey: "engine.label.voxcpm2", noteKey: "voxcpm.voxcpm2.note" },
  { id: "voxcpm1.5", labelKey: "engine.label.voxcpm1.5", noteKey: "voxcpm.voxcpm1.5.note" },
  { id: "voxcpm-0.5b", labelKey: "engine.label.voxcpm-0.5b", noteKey: "voxcpm.voxcpm-0.5b.note" },
];

const localModelReady = (status: RuntimeStatus, id: TtsEngine): boolean => {
  if (id === "cosyvoice2") return Boolean(status.tts.engines?.cosyvoice2?.ready);
  return Boolean(status.tts.engines?.voxcpm?.models[id]?.ready);
};

export function DubbingControls({ busy, status, characters, charactersLoading, presets, presetsError, playingPresetId, preparingPresetId, engine, engineReady, engineNeedsCharacter, voxcpmEngine, style, text, selection, cloudResult, cloudBusy, onPreviewPreset, onSelect, onEngineChange, onStyleChange, onTextChange, onOpenSettings, onSubmit, step, onBack, onNext }: {
  busy: string | null;
  status: RuntimeStatus;
  characters: VoiceCharacter[];
  charactersLoading: boolean;
  presets: VoicePreset[];
  presetsError: string;
  playingPresetId: string;
  preparingPresetId: string;
  engine: TtsEngine;
  engineReady: boolean;
  engineNeedsCharacter: boolean;
  voxcpmEngine: VoxCpmEngineStatus | null;
  style: VoiceStyle;
  text: string;
  selection: DubbingSelection;
  cloudResult: { url: string; name: string } | null;
  cloudBusy: boolean;
  onPreviewPreset: (id: string) => void;
  onSelect: (selection: DubbingSelection) => void;
  onEngineChange: (value: TtsEngine) => void;
  onStyleChange: (value: VoiceStyle) => void;
  onTextChange: (value: string) => void;
  onOpenSettings: (focus: "environment" | "asr" | "tts") => void;
  onSubmit: () => void;
  step: number;
  onBack: () => void;
  onNext: () => void;
}) {
  const locale = useRecutLocale();
  const canRun = !busy && !cloudBusy && Boolean(text.trim()) && (selection.cloud ? Boolean(selection.cloud.voiceId) : engineReady && (!engineNeedsCharacter || Boolean(selection.characterId) || Boolean(selection.presetId)));
  const styles: { id: VoiceStyle; labelKey: I18nKey }[] = [
    { id: "neutral", labelKey: "style.neutral" },
    { id: "calm", labelKey: "style.calm" },
    { id: "excited", labelKey: "style.excited" },
    { id: "gentle", labelKey: "style.gentle" },
  ];
  const selectedName = selection.cloud ? selection.cloud.name
    : selection.presetId ? localizedText(locale, presets.find((item) => item.id === selection.presetId)?.name ?? "") || selection.presetId
    : selection.characterId ? characters.find((item) => item.id === selection.characterId)?.name || selection.characterId
    : t(locale, engine === "cosyvoice2" ? "character.defaultVoice" : "voxcpm.defaultVoice");
  return <div className="flex flex-col gap-6">
    {step === 0 && <DubbingVoiceTabs busy={busy} characters={characters} charactersLoading={charactersLoading} engine={engine} engineReady={engineReady} playingPresetId={playingPresetId} preparingPresetId={preparingPresetId} presets={presets} presetsError={presetsError} selection={selection} status={status} voxcpmEngine={voxcpmEngine} onEngineChange={onEngineChange} onOpenSettings={onOpenSettings} onPreviewPreset={onPreviewPreset} onSelect={onSelect} />}
    {step === 1 && <>
      <p className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs"><strong className="font-medium">{tF(locale, "dubbing.selected.voice", { name: selectedName })}</strong></p>
      {!selection.cloud && engine === "cosyvoice2" && <div className="grid gap-2">
        <Label className="text-xs text-muted-foreground">{t(locale, "controls.style.title")}</Label>
        <div className="grid grid-cols-4 gap-1 rounded-md border bg-muted/50 p-1">{styles.map((item) => <Button className={cn(style === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => onStyleChange(item.id)} type="button" variant="ghost" size="sm">{t(locale, item.labelKey)}</Button>)}</div>
      </div>}
      <div className="grid gap-2">
        <Label className="text-xs text-muted-foreground">{t(locale, "controls.text.title")}</Label>
        <Textarea aria-label={t(locale, "controls.text.title")} disabled={busy !== null || cloudBusy} onChange={(event) => onTextChange(event.target.value)} placeholder={t(locale, "controls.text.placeholder")} rows={6} value={text} />
      </div>
      {cloudBusy && <p className="flex items-center gap-1.5 text-xs font-medium text-sky-500"><RefreshCw className="size-3.5 animate-spin" />{t(locale, "dubbing.cloud.progress")}</p>}
      {cloudResult && <div className="grid gap-2 rounded-lg border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2"><strong className="truncate text-xs font-medium">{cloudResult.name}</strong><Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "dubbing.cloud.done")}</Badge></div>
        <audio className="w-full" controls preload="metadata" src={cloudResult.url} />
      </div>}
    </>}
    <StepFooter busy={busy === "synthesize" || cloudBusy ? "synthesize" : null} finishDisabled={!canRun} finishLabel={busy === "synthesize" || cloudBusy ? <><RefreshCw className="size-4 animate-spin" />{t(locale, "nav.synthesize.label")}</> : <><Wand2 className="size-4" />{t(locale, "nav.synthesize.label")}</>} onBack={onBack} onFinish={onSubmit} onNext={onNext} step={step} total={2} />
  </div>;
}

function StepFooter({ step, total, busy, onBack, onNext, onFinish, finishDisabled, finishLabel }: { step: number; total: number; busy: string | null; onBack: () => void; onNext: () => void; onFinish: () => void; finishDisabled: boolean; finishLabel: ReactNode }) {
  const locale = useRecutLocale();
  const disabled = busy !== null;
  return <div className="flex items-center justify-between gap-3 pt-1">
    <div className="flex gap-1.5">{Array.from({ length: total }).map((_, index) => <span className={cn("h-1.5 w-6 rounded-full", index <= step ? "bg-primary" : "bg-muted")} key={index} />)}</div>
    <div className="flex items-center gap-2">
      {step > 0 && <Button className="min-w-20" disabled={disabled} onClick={onBack} type="button" variant="ghost">{t(locale, "stepper.back")}</Button>}
      {step < total - 1
        ? <Button className="min-w-24" disabled={disabled} onClick={onNext} type="button">{t(locale, "stepper.next")}</Button>
        : <Button className="min-w-32" disabled={disabled || finishDisabled} onClick={onFinish} type="button" size="lg">{finishLabel}</Button>}
    </div>
  </div>;
}

// ---- 配音声音分组：多页签布局，每个 provider 一个独立页签，页签体只有一个滚动区 ----

function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block animate-pulse rounded-md bg-muted", className)} />;
}

// 云端声音分组加载：平台 /v1/media/capabilities/speech.generate/voices 聚合。
function useCloudVoiceGroups() {
  const locale = useRecutLocale();
  const [groups, setGroups] = useState<PlatformVoiceGroup[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/v1/media/capabilities/speech.generate/voices");
      const data = await fetchJSON(response);
      if (!response.ok) throw new Error(typeof (data as any)?.error === "string" ? (data as any).error : t(locale, "dubbing.cloud.loadFailed"));
      setGroups(Array.isArray(data) ? data : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t(locale, "dubbing.cloud.loadFailed")); }
    finally { setLoading(false); }
  }, [locale]);
  useEffect(() => { void load(); }, [load]);
  return { groups, error, loading, reload: load };
}

// 配音页签：本机一个页签 + 每个云端凭据一个页签；同一时刻只渲染一个分组，避免多滚动条。
function DubbingVoiceTabs({ busy, characters, charactersLoading, engine, engineReady, playingPresetId, preparingPresetId, presets, presetsError, selection, status, voxcpmEngine, onEngineChange, onOpenSettings, onPreviewPreset, onSelect }: {
  busy: string | null;
  characters: VoiceCharacter[];
  charactersLoading: boolean;
  engine: TtsEngine;
  engineReady: boolean;
  playingPresetId: string;
  preparingPresetId: string;
  presets: VoicePreset[];
  presetsError: string;
  selection: DubbingSelection;
  status: RuntimeStatus;
  voxcpmEngine: VoxCpmEngineStatus | null;
  onEngineChange: (value: TtsEngine) => void;
  onOpenSettings: (focus: "environment" | "asr" | "tts") => void;
  onPreviewPreset: (id: string) => void;
  onSelect: (selection: DubbingSelection) => void;
}) {
  const locale = useRecutLocale();
  const cloud = useCloudVoiceGroups();
  const cloudGroups = useMemo(() => (cloud.groups ?? []).filter((group) => group.credentialId || (group.error && group.provider !== "local-audio")), [cloud.groups]);
  const tabs = useMemo<{ id: string; label: string; group?: PlatformVoiceGroup }[]>(() => [
    { id: "local", label: t(locale, "dubbing.group.local") },
    ...cloudGroups.map((group) => ({ id: `${group.provider}-${group.credentialId || "unconfigured"}`, label: group.provider, group })),
  ], [cloudGroups, locale]);
  const [active, setActive] = useState("local");
  // 每个云端凭据页签记住用户选中的语音模型（换页签再回来不丢失）。
  const [cloudModels, setCloudModels] = useState<Record<string, string>>({});
  useEffect(() => { if (active !== "local" && !tabs.some((item) => item.id === active)) setActive("local"); }, [tabs, active]);
  const activeGroup = active === "local" ? null : tabs.find((item) => item.id === active)?.group ?? null;
  const cloudKey = activeGroup?.credentialId || activeGroup?.provider || "";
  return <div className="grid gap-3">
    <div className="flex w-fit min-w-0 flex-wrap items-center gap-1 rounded-lg bg-muted/40 p-1">
      {tabs.map((item) => <Button className={cn("rounded-md px-3 py-1.5 text-xs", active === item.id ? "bg-background text-foreground shadow-xs hover:bg-background" : "text-muted-foreground hover:text-foreground")} disabled={busy !== null} key={item.id} onClick={() => setActive(item.id)} type="button" variant="ghost">{item.label}</Button>)}
      {cloud.loading && <span className="flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground"><Skeleton className="h-4 w-16" />{t(locale, "dubbing.tabs.loading")}</span>}
    </div>
    {active === "local" || !activeGroup
      ? <LocalVoiceGroup busy={busy} characters={characters} charactersLoading={charactersLoading} engine={engine} engineReady={engineReady} playingPresetId={playingPresetId} preparingPresetId={preparingPresetId} presets={presets} presetsError={presetsError} selection={selection} status={status} voxcpmEngine={voxcpmEngine} onEngineChange={onEngineChange} onOpenSettings={onOpenSettings} onPreviewPreset={onPreviewPreset} onSelect={onSelect} />
      : <CloudGroup busy={busy} group={activeGroup} modelId={cloudModels[cloudKey] ?? ""} selection={selection} onSelect={onSelect} onModelChange={(value) => setCloudModels((current) => ({ ...current, [cloudKey]: value })) } />}
    {cloud.error ? <div className="grid gap-2"><p className="text-[11px] text-destructive">{t(locale, "dubbing.cloud.loadFailed")}：{cloud.error}</p><Button disabled={cloud.loading} onClick={() => void cloud.reload()} size="sm" type="button" variant="outline" className="w-fit"><RefreshCw className="size-3.5" />{t(locale, "dubbing.cloud.retry")}</Button></div> : null}
  </div>;
}

// 本机页签：页签头右侧扁平选择本地模型（选中即确定引擎+权重），页签体列出默认音、预设与我的角色。
// 模型选择复用全局设置 ModelPicker 的体验：Popover 触发按钮（模型名 + 说明副行），
// 内容区左侧候选列表 + 右侧悬停/选中模型详情卡（就绪状态、规格说明、未就绪时的设置入口）。
function LocalVoiceGroup({ busy, characters, charactersLoading, engine, engineReady, playingPresetId, preparingPresetId, presets, presetsError, selection, status, voxcpmEngine, onEngineChange, onOpenSettings, onPreviewPreset, onSelect }: {
  busy: string | null;
  characters: VoiceCharacter[];
  charactersLoading: boolean;
  engine: TtsEngine;
  engineReady: boolean;
  playingPresetId: string;
  preparingPresetId: string;
  presets: VoicePreset[];
  presetsError: string;
  selection: DubbingSelection;
  status: RuntimeStatus;
  voxcpmEngine: VoxCpmEngineStatus | null;
  onEngineChange: (value: TtsEngine) => void;
  onOpenSettings: (focus: "environment" | "asr" | "tts") => void;
  onPreviewPreset: (id: string) => void;
  onSelect: (selection: DubbingSelection) => void;
}) {
  const locale = useRecutLocale();
  const localSelected = !selection.cloud;
  const defaultVoiceKey = engine === "cosyvoice2" ? "character.defaultVoice" : "voxcpm.defaultVoice";
  return <section className="grid gap-3 rounded-xl bg-muted/30 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate text-sm font-semibold">{t(locale, "dubbing.group.local")}</h3>
        {localSelected && <Badge className="shrink-0 text-[10px]" variant="secondary"><Check className="mr-1 size-3" />{t(locale, "dubbing.group.default")}</Badge>}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] text-foreground/60">{t(locale, "dubbing.group.model")}</span>
        <ModelPickerPopover
          onChange={(id) => onEngineChange(id as TtsEngine)}
          options={localModels.map((item) => {
            const ready = localModelReady(status, item.id);
            const note = t(locale, item.noteKey);
            return {
              id: item.id,
              title: t(locale, item.labelKey),
              subtitle: note,
              ready,
              detail: [
                { label: t(locale, "dubbing.group.model"), value: t(locale, item.labelKey) },
                { label: "规格", value: note },
              ],
              action: ready ? null : <Button disabled={busy !== null} onClick={() => onOpenSettings("tts")} size="sm" type="button" variant="outline" className="w-fit"><Settings className="size-3.5" />{t(locale, "settings.open")}</Button>,
            };
          })}
          value={engine}
        />
      </div>
    </div>
    <p className="text-[11px] text-foreground/60">{t(locale, "dubbing.group.localNote")}</p>
    {!engineReady && <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><p className="text-amber-600">{tF(locale, "dubbing.engine.notReady", { model: t(locale, localModels.find((item) => item.id === engine)?.labelKey ?? "engine.label.cosyvoice2") })}</p><Button disabled={busy !== null} onClick={() => onOpenSettings("tts")} size="sm" type="button" variant="outline" className="w-fit"><Settings className="size-3.5" />{t(locale, "settings.open")}</Button></div>}
    {engine !== "cosyvoice2" && voxcpmEngine && !voxcpmEngine.runtime && <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><strong className="text-amber-600">{t(locale, "voxcpm.runtimeMissing")}</strong><Button disabled={busy !== null} onClick={() => onOpenSettings("environment")} size="sm" type="button" variant="outline" className="w-fit"><Settings className="size-3.5" />{t(locale, "settings.open")}</Button></div>}
    <div className="grid max-h-72 gap-2 overflow-auto pr-1 min-[560px]:grid-cols-2">
      {(engine === "cosyvoice2" || engine === "voxcpm2") && <VoiceRow checked={localSelected && !selection.characterId && !selection.presetId} description={t(locale, engine === "cosyvoice2" ? "character.defaultVoiceNote" : "voxcpm.defaultVoiceNote")} disabled={busy !== null} name={t(locale, defaultVoiceKey)} onSelect={() => onSelect({ characterId: "", presetId: "", cloud: null })} />}
      {presets.map((preset) => <PresetCard busy={busy} key={`preset-${preset.id}`} locale={locale} onPlay={() => onPreviewPreset(preset.id)} onSelect={() => onSelect({ characterId: "", presetId: preset.id, cloud: null })} playing={playingPresetId === preset.id} preparing={preparingPresetId === preset.id} preset={preset} selected={localSelected && selection.presetId === preset.id} />)}
      {charactersLoading
        ? [0, 1, 2, 3].map((index) => <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5" key={`character-skeleton-${index}`}><span className="grid min-w-0 flex-1 gap-1.5"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3 w-36" /></span><Skeleton className="size-8 shrink-0 rounded-full" /></div>)
        : characters.map((character) => <VoiceRow checked={localSelected && selection.characterId === character.id} description={`${t(locale, originLabelKey(character.origin))} · ${character.model.replace("whisper-", "")}`} disabled={busy !== null} key={`character-${character.id}`} name={character.name} previewURL={character.sampleURL} onSelect={() => onSelect({ characterId: character.id, presetId: "", cloud: null })} />)}
      {!presets.length && !presetsError && <p className="col-span-full py-2 text-center text-[11px] text-muted-foreground">{t(locale, "preset.empty")}</p>}
      {presetsError && <p className="col-span-full text-[11px] text-destructive">{presetsError}</p>}
    </div>
  </section>;
}

// 云端页签体：页签头选择该 provider 的语音模型；未配置凭据的 provider 显示设置引导。
// 模型选择独立于音色选择：未选音色时也能换模型；换模型后默认声音角色随模型切换
// （新模型首个音色成为默认选中项；无音色的模型清空选择，避免把旧 voiceId 传给新模型）。
function CloudGroup({ busy, group, modelId, selection, onSelect, onModelChange }: { busy: string | null; group: PlatformVoiceGroup; modelId: string; selection: DubbingSelection; onSelect: (selection: DubbingSelection) => void; onModelChange: (modelId: string) => void }) {
  const locale = useRecutLocale();
  const configured = Boolean(group.credentialId);
  // 音色随模型走：modelId 为空的音色是 provider 级清单（对该 provider 所有模型可用），
  // 其余只在与当前选中模型匹配时展示——换模型不会出现错配的 voiceId。
  const voicesFor = useCallback((id: string) => group.voices.filter((voice) => !voice.modelId || voice.modelId === id), [group.voices]);
  // 默认模型 = 第一个有音色的模型（跳过无内置音色的参考型 TTS），兼容期回退首个模型。
  const defaultModelId = useMemo(() => group.models.find((model) => voicesFor(model.id).length > 0)?.id ?? group.models[0]?.id ?? "", [group.models, voicesFor]);
  const effectiveModelId = group.models.some((model) => model.id === modelId) ? modelId : defaultModelId;
  const visibleVoices = effectiveModelId ? voicesFor(effectiveModelId) : [];
  const switchModel = (value: string) => {
    if (!configured || value === effectiveModelId) return;
    onModelChange(value);
    const first = voicesFor(value)[0];
    onSelect(first
      ? { characterId: "", presetId: "", cloud: { credentialId: group.credentialId!, modelId: value, voiceId: first.id, name: first.name } }
      : { characterId: "", presetId: "", cloud: { credentialId: group.credentialId!, modelId: value, voiceId: "", name: "" } });
  };
  return <section className="grid gap-3 rounded-xl bg-muted/30 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate text-sm font-semibold">{group.provider}{group.credentialName ? <span className="ml-1.5 text-[11px] font-normal text-foreground/60">{group.credentialName}</span> : null}</h3>
        {group.isDefaultRoute && <Badge className="shrink-0 text-[10px]" variant="secondary">{t(locale, "dubbing.group.default")}</Badge>}
        {selection.cloud && selection.cloud.credentialId === group.credentialId && <Badge className="shrink-0 text-[10px]" variant="secondary"><Check className="mr-1 size-3" />{t(locale, "dubbing.group.default")}</Badge>}
      </div>
      {configured && group.models.length > 0 && <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] text-foreground/60">{t(locale, "dubbing.cloud.models")}</span>
        <ModelPickerPopover
          onChange={switchModel}
          options={group.models.map((model) => ({ id: model.id, title: model.name || model.id, subtitle: group.provider, ready: null, detail: [
            { label: t(locale, "dubbing.cloud.models"), value: model.name || model.id },
            { label: "Provider", value: group.provider },
            { label: t(locale, "dubbing.cloud.voices"), value: String(voicesFor(model.id).length) },
          ], action: null }))}
          value={effectiveModelId}
        />
      </div>}
    </div>
    {!configured ? <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><p className="flex items-center gap-1.5 text-amber-600"><Settings className="size-3.5" />{t(locale, "dubbing.group.unconfigured")}</p><p className="text-[11px] leading-relaxed text-muted-foreground">{tF(locale, "dubbing.group.configureHint", { provider: group.provider })}</p></div>
      : group.error && !visibleVoices.length ? <p className="text-[11px] text-destructive">{group.error}</p>
      : <div className="grid max-h-56 gap-2 overflow-auto pr-1 min-[560px]:grid-cols-2">
        {visibleVoices.map((voice) => <CloudVoiceRow busy={busy} group={group} key={voice.id} selected={Boolean(selection.cloud && selection.cloud.credentialId === group.credentialId && selection.cloud.voiceId === voice.id)} voice={voice} onSelect={() => onSelect({ characterId: "", presetId: "", cloud: { credentialId: group.credentialId!, voiceId: voice.id, modelId: effectiveModelId, name: voice.name } })} />)}
        {!visibleVoices.length && <p className="col-span-full py-2 text-center text-[11px] text-muted-foreground">{t(locale, "dubbing.cloud.empty")}</p>}
      </div>}
  </section>;
}

function CloudVoiceRow({ busy, group, voice, selected, onSelect }: { busy: string | null; group: PlatformVoiceGroup; voice: PlatformVoiceGroup["voices"][number]; selected: boolean; onSelect: () => void }) {
  const locale = useRecutLocale();
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const key = `${group.credentialId}:${voice.id}`;
  const play = (url: string) => {
    previewAudio.current?.pause();
    const audio = new Audio(url);
    audio.onended = () => setPreviewKey((current) => (current === key ? "" : current));
    previewAudio.current = audio;
    void audio.play().catch(() => {});
    setPreviewKey(key);
  };
  useEffect(() => () => previewAudio.current?.pause(), []);
  const preview = async () => {
    const current = previewAudio.current;
    if (previewKey === key && current) {
      if (current.paused) { void current.play().catch(() => {}); }
      else current.pause();
      return;
    }
    if (voice.previewUrl) { play(voice.previewUrl); return; }
    if (loading) return;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/v1/media/credentials/${group.credentialId}/voices/${voice.id}/preview`);
      const data = await fetchJSON(response);
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : t(locale, "dubbing.cloud.loadFailed"));
      if (typeof data.previewUrl === "string" && data.previewUrl) { play(data.previewUrl); return; }
      const jobId = typeof data.id === "string" ? data.id : "";
      if (!jobId) throw new Error(t(locale, "dubbing.cloud.loadFailed"));
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const jobResponse = await fetch(`/v1/media/jobs/${jobId}`);
        const job = await fetchJSON(jobResponse);
        if (job.status === "completed" && Array.isArray(job.assetIds) && job.assetIds[0]) { play(`/v1/media/assets/${job.assetIds[0]}/content`); return; }
        if (job.status === "failed") throw new Error(job.error || "preview job failed");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  return <div className={cn("flex items-start justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors", selected ? "border-primary bg-primary/10" : "bg-card hover:border-foreground/25 hover:bg-card")}>
    <button aria-pressed={selected} className="grid min-w-0 flex-1 gap-0.5 text-left disabled:pointer-events-none disabled:opacity-50" disabled={busy !== null} onClick={onSelect} type="button">
      <span className="flex items-center gap-1.5"><strong className="truncate font-medium">{voice.name}</strong>{voice.category ? <Badge className="shrink-0 px-1.5 py-0 text-[9px]" variant="outline">{voice.category}</Badge> : null}</span>
      {voice.description && <small className="line-clamp-2 text-foreground/75">{voice.description}</small>}
      {error && <small className="text-destructive">{tF(locale, "dubbing.cloud.preview.failed", { error })}</small>}
    </button>
    <Button aria-label={t(locale, "preset.play")} className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground" disabled={busy !== null || loading} onClick={() => void preview()} size="icon" type="button" variant="ghost">{loading ? <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : previewKey === key && !previewAudio.current?.paused ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</Button>
  </div>;
}


// fetchJSON 安全解析：服务端旧版本或代理返回非 JSON（如 HTML 错误页）时给出可读错误，
// 而不是 "Unexpected non-whitespace character after JSON"。
async function fetchJSON(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: ${(text.trim() || "non-JSON response").slice(0, 120)}`); }
}

// ModelPickerPopover 复用全局设置 ModelPicker 的双栏体验：触发按钮显示选中模型名 + 说明副行，
// 内容区左侧候选列表（含就绪徽标）+ 右侧悬停/选中模型的详情卡与可选动作（如「打开设置」）。
type ModelPickerOption = { id: string; title: string; subtitle: string; ready: boolean | null; detail: { label: string; value: ReactNode }[]; action: ReactNode | null };

function ModelPickerPopover({ options, value, onChange }: { options: ModelPickerOption[]; value: string; onChange: (id: string) => void }) {
  const locale = useRecutLocale();
  const [open, setOpen] = useState(false);
  const [previewID, setPreviewID] = useState(value);
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const visible = normalized ? options.filter((option) => `${option.title} ${option.subtitle}`.toLowerCase().includes(normalized)) : options;
  const selected = options.find((option) => option.id === value) ?? options[0];
  const preview = options.find((option) => option.id === previewID) ?? selected;
  if (!selected) return null;
  const readyBadge = (ready: boolean | null) => ready === null ? null : <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[9px]", ready ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-600")}>{t(locale, ready ? "settings.env.ready" : "settings.env.missing")}</span>;
  return <Popover onOpenChange={setOpen} open={open}>
    <PopoverTrigger asChild>
      <button aria-label={selected.title} className="flex min-h-8 w-[260px] items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1 text-left text-xs hover:bg-muted" type="button">
        <span className="min-w-0">
          <span className="block truncate font-medium">{selected.title}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{selected.subtitle}</span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-[540px] p-0">
      <div className="grid grid-cols-[230px_minmax(0,1fr)] overflow-hidden">
        <div className="flex min-h-0 flex-col border-r">
          <div className="relative p-2 pb-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input aria-label={t(locale, "dubbing.cloud.models")} className="h-8 w-full rounded-sm border bg-background pl-8 pr-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" onChange={(event) => setQuery(event.target.value)} placeholder={t(locale, "dubbing.cloud.models")} type="search" value={query} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1 pt-0" style={{ maxHeight: 320 }}>
            {visible.map((option) => {
              const active = option.id === value;
              return <button aria-selected={active} className={cn("flex w-full items-center justify-between gap-2 rounded-xs px-2.5 py-2 text-left text-xs hover:bg-muted", active ? "bg-accent" : "")} key={option.id} onClick={() => { onChange(option.id); setOpen(false); }} onFocus={() => setPreviewID(option.id)} onMouseEnter={() => setPreviewID(option.id)} role="option" type="button">
                <span className="min-w-0 truncate">{option.title}</span>
                <span className="flex shrink-0 items-center gap-1">{readyBadge(option.ready)}{active && <Check className="size-3.5 text-primary" />}</span>
              </button>;
            })}
            {!visible.length && <p className="px-2.5 py-4 text-center text-[11px] text-muted-foreground">{t(locale, "preset.empty")}</p>}
          </div>
        </div>
        <div className="flex flex-col gap-2 p-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><p className="truncate font-medium">{preview.title}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{preview.subtitle}</p></div>
            {readyBadge(preview.ready)}
          </div>
          <dl className="grid gap-1.5">
            {preview.detail.map((row) => <div className="flex items-start justify-between gap-3" key={row.label}><dt className="shrink-0 pt-0.5 text-muted-foreground">{row.label}</dt><dd className="min-w-0 text-right font-medium">{row.value}</dd></div>)}
          </dl>
          {preview.action}
        </div>
      </div>
    </PopoverContent>
  </Popover>;
}

// 通用声音行：名称 + 描述 + 可选试听（本地角色样音）。
function VoiceRow({ name, description, previewURL, checked, disabled, onSelect }: { name: string; description: string; previewURL?: string; checked: boolean; disabled: boolean; onSelect: () => void }) {
  const locale = useRecutLocale();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => audioRef.current?.pause(), []);
  const toggle = () => {
    if (!previewURL) return;
    if (audioRef.current) {
      if (audioRef.current.paused) { void audioRef.current.play().catch(() => {}); setPlaying(true); }
      else { audioRef.current.pause(); setPlaying(false); }
      return;
    }
    const audio = new Audio(previewURL);
    audio.onended = () => setPlaying(false);
    audioRef.current = audio;
    void audio.play().catch(() => {});
    setPlaying(true);
  };
  return <div className={cn("flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors", checked ? "border-primary bg-primary/10" : "hover:bg-muted")}>
    <button aria-pressed={checked} className="grid min-w-0 flex-1 gap-0.5 text-left disabled:pointer-events-none disabled:opacity-50" disabled={disabled} onClick={onSelect} type="button">
      <strong className="truncate font-medium">{name}</strong>
      {description && <small className="truncate text-foreground/75">{description}</small>}
    </button>
    {previewURL && <Button aria-label={t(locale, playing ? "preset.pause" : "preset.play")} className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground" onClick={toggle} size="icon" type="button" variant="ghost">{playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</Button>}
  </div>;
}
