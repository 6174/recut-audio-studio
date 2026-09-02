/**
 * [INPUT]: 依赖 i18n、types、shadcn/ui 组件与 lucide 图标；audio.presets 可能返回 {zh,en} 本地化对象
 * [OUTPUT]: 页签式声音选择器（预设 / 我的角色，预设页签按场景分组，试听经 audio.preset.prepare 按需后台下载后播放）与「设计声音」弹框（名称 + 音色描述 + 从预设起步 + 保存到素材库）
 * [POS]: audio-studio Phase 2 的预设选择与 Voice Design UI；预设名称/blurb 来自 op 返回值，需先折叠为当前 locale 字符串
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Pause, Play, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useRecutLocale, type Locale } from "./recut-sdk";
import type { LocalizedText, VoiceCharacter, VoicePreset, VoiceScene } from "./types";
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
      {showDefaultVoice && <button aria-pressed={!selectedCharacterId && !selectedPresetId} className={cn("flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", !selectedCharacterId && !selectedPresetId ? "border-primary bg-primary/10" : "hover:bg-muted/70")} disabled={busy !== null} onClick={() => onSelectCharacter("")} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{t(locale, defaultVoiceLabelKey)}</strong></span>{!selectedCharacterId && !selectedPresetId && <Check className="size-3.5 shrink-0 text-primary" />}</button>}
      {characters.map((character) => <button aria-pressed={selectedCharacterId === character.id} className={cn("flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50", selectedCharacterId === character.id ? "border-primary bg-primary/10" : "hover:bg-muted/70")} disabled={busy !== null} key={character.id} onClick={() => onSelectCharacter(character.id)} type="button"><span className="grid min-w-0 gap-0.5"><strong className="truncate font-medium">{character.name}</strong></span>{selectedCharacterId === character.id && <Check className="size-3.5 shrink-0 text-primary" />}</button>)}
    </div>}
  </div>;
}

function PresetCard({ preset, selected, busy, playing, preparing, onPlay, onSelect, locale }: { preset: VoicePreset; selected: boolean; busy: string | null; playing: boolean; preparing: boolean; onPlay: () => void; onSelect: () => void; locale: Locale }) {
  return <div className={cn("flex items-start justify-between gap-2 rounded-xl border px-3 py-3 text-left text-xs transition-colors", selected ? "border-primary bg-primary/10 shadow-[0_0_0_1px_rgba(34,197,94,0.08)]" : "bg-card/70 hover:border-border hover:bg-card")}>
    <button aria-pressed={selected} className="grid min-w-0 flex-1 gap-1 text-left disabled:pointer-events-none disabled:opacity-50" disabled={busy !== null} onClick={onSelect} type="button">
      <span className="flex items-center gap-1.5"><strong className="truncate font-medium">{localizedText(locale, preset.name)}</strong>{preset.source === "bootstrap" ? <Badge className="shrink-0 px-1 py-0 text-[9px]" variant="outline">{t(locale, "preset.bootstrap")}</Badge> : null}</span>
      <small className="line-clamp-2 text-muted-foreground">{localizedText(locale, preset.blurb)}</small>
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

export function DesignVoiceDialog({ open, onClose, presets, busy, onSubmit }: { open: boolean; onClose: () => void; presets: VoicePreset[]; busy: string | null; onSubmit: (input: { name: string; designDesc?: string; presetId?: string; saveToLibrary: boolean }) => void }) {
  const locale = useRecutLocale();
  const [name, setName] = useState("");
  const [designDesc, setDesignDesc] = useState("");
  const [fromPreset, setFromPreset] = useState("");
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  useEffect(() => { if (open) { setName(""); setDesignDesc(""); setFromPreset(""); setSaveToLibrary(true); } }, [open]);
  if (!open) return null;
  const submit = () => {
    if (!name.trim()) return;
    if (!designDesc.trim() && !fromPreset) return;
    onSubmit({ name: name.trim(), designDesc: fromPreset ? undefined : designDesc.trim() || undefined, presetId: fromPreset || undefined, saveToLibrary });
  };
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
    <div className="flex max-h-[min(720px,calc(100dvh-32px))] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Wand2 className="size-4 text-primary" />{t(locale, "design.title")}</h2>
        <Button aria-label="close" onClick={onClose} type="button" variant="ghost" size="icon"><span className="text-sm">✕</span></Button>
      </div>
      <div className="min-h-0 overflow-y-auto p-5">
        <div className="grid gap-4">
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground" htmlFor="design-name">{t(locale, "character.name.label")}</Label>
          <Input id="design-name" onChange={(event) => setName(event.target.value)} placeholder={t(locale, "design.name.placeholder")} value={name} />
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground" htmlFor="design-desc">{t(locale, "design.desc.label")}</Label>
          <Textarea id="design-desc" maxLength={120} onChange={(event) => { setFromPreset(""); setDesignDesc(event.target.value); }} placeholder={t(locale, "design.desc.placeholder")} rows={4} value={designDesc} />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t(locale, "design.desc.hint")}</p>
            <span className={cn("shrink-0 font-mono text-[10px]", designDesc.length >= 120 ? "text-destructive" : "text-muted-foreground")}>{tF(locale, "design.charCount", { count: designDesc.length })}</span>
          </div>
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground" htmlFor="design-from-preset">{t(locale, "design.fromPreset")}</Label>
          <Select onValueChange={(value) => { setFromPreset(value === "__none" ? "" : value); const preset = presets.find((item) => item.id === value); if (preset?.designDesc) setDesignDesc(preset.designDesc); }} value={fromPreset || "__none"}>
            <SelectTrigger id="design-from-preset" className="h-9 w-full min-w-0"><SelectValue placeholder={t(locale, "design.fromPreset.placeholder")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">{t(locale, "design.fromPreset.placeholder")}</SelectItem>
              {presets.map((preset) => <SelectItem key={preset.id} value={preset.id}>{localizedText(locale, preset.name)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
          <input checked={saveToLibrary} className="size-3.5 accent-[var(--primary,currentColor)]" onChange={(event) => setSaveToLibrary(event.target.checked)} type="checkbox" />
          {t(locale, "design.saveToLibrary")}
        </label>
        <div className="flex items-center justify-end gap-2 border-t pt-4">
          <Button disabled={busy !== null} onClick={onClose} type="button" variant="ghost">{t(locale, "dialog.close")}</Button>
          <Button disabled={busy !== null || !name.trim() || (!designDesc.trim() && !fromPreset)} onClick={submit} title={!designDesc.trim() && !fromPreset ? t(locale, "design.descRequired") : undefined} type="button">{busy === "character" ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Wand2 className="size-4" />}{t(locale, "design.submit")}</Button>
        </div>
        </div>
      </div>
    </div>
  </div>;
}
