/**
 * [INPUT]: 依赖 lucide 图标、shadcn/ui Badge/Button、recut-sdk、i18n、voice 的 originLabelKey 与 lib/format（timestamp）
 * [OUTPUT]: 声音角色模态框内容件：CharacterEntries（三入口卡：上传参考音 / VoxCPM 设计 / 管理）与 CharList（角色卡列表，可进入详情）
 * [POS]: audio-studio 声音角色模态框的一级/管理视图内容
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import type { ReactNode } from "react";
import { Check, ChevronRight, Upload, Users, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useRecutLocale } from "../recut-sdk";
import type { VoiceCharacter } from "../types";
import { t, tF } from "../i18n";
import { originLabelKey } from "../voice";
import { timestamp } from "../lib/format";

export function CharList({ characters, onOpen }: { characters: VoiceCharacter[]; onOpen: (character: VoiceCharacter) => void }) {
  const locale = useRecutLocale();
  return <div className="grid gap-3 min-[560px]:grid-cols-2">
    {characters.length ? characters.map((character) => <button className="group grid gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:border-ring hover:bg-muted" key={character.id} onClick={() => onOpen(character)} type="button"><span className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-sm font-semibold">{character.name}</span>{character.sampleAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</span><span className="text-[11px] text-muted-foreground">{t(locale, originLabelKey(character.origin))} · {character.model.replace("whisper-", "")} · {timestamp(locale, character.createdAt)}</span></button>) : <p className="col-span-full py-8 text-center text-sm text-muted-foreground">{t(locale, "characters.empty")}</p>}
  </div>;
}

// 声音角色一级模态框：三张入口卡（上传参考音 / VoxCPM 设计 / 管理），点击进入二级模态框。
export function CharacterEntries({ characters, designReady, onPick }: { characters: VoiceCharacter[]; designReady: boolean; onPick: (entry: "clone" | "design" | "manage") => void }) {
  const locale = useRecutLocale();
  const entries: { id: "clone" | "design" | "manage"; icon: ReactNode; title: string; desc: string; badge?: ReactNode }[] = [
    { id: "clone", icon: <Upload className="size-4" />, title: t(locale, "characters.entry.clone.title"), desc: t(locale, "characters.entry.clone.desc") },
    { id: "design", icon: <Wand2 className="size-4 text-primary" />, title: t(locale, "characters.entry.design.title"), desc: t(locale, "characters.entry.design.desc"), badge: designReady ? <Badge className="shrink-0 text-[10px]" variant="secondary">{t(locale, "characters.entry.design.ready")}</Badge> : <Badge className="shrink-0 text-[10px] text-amber-600" variant="outline">{t(locale, "characters.entry.design.missing")}</Badge> },
    { id: "manage", icon: <Users className="size-4" />, title: t(locale, "characters.entry.manage.title"), desc: tF(locale, "characters.entry.manage.desc", { count: characters.length }) },
  ];
  return <div className="grid gap-2">
    <p className="text-xs text-muted-foreground">{t(locale, "characters.entries.hint")}</p>
    {entries.map((item) => <button className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border p-3.5 text-left transition-colors hover:border-ring hover:bg-muted/60" key={item.id} onClick={() => onPick(item.id)} type="button">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">{item.icon}</span>
      <span className="grid min-w-0 gap-1"><span className="flex items-center gap-2 text-sm font-semibold leading-none">{item.title}{item.badge}</span><small className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{item.desc}</small></span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>)}
  </div>;
}
