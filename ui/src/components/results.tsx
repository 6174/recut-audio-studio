/**
 * [INPUT]: 依赖 shadcn/ui Card、lucide 图标、recut-sdk、i18n、voice 的 originLabelKey、lib/format（buildSRT/formatTimecode/timestamp/kindLabel/languageLabel/copyText/downloadBlob）与 lib/options（speechModels/engineLabel/styleLabel）
 * [OUTPUT]: 任务详情的结果输出件：TranscriptOutput（分段可编辑文稿 + SRT 预览/复制/下载 + 入库）、CharacterPreview（角色样音 + 提示词 + 入库/删除）、SynthesisOutput（配音播放 + 入库）
 * [POS]: 渲染在 TaskDetail 的结果卡片内；保存动作经回调交回 App 编排层
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { useState } from "react";
import { Check, Copy, Download, FileAudio, LoaderCircle, MessageSquareText, Save, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useRecutLocale } from "../recut-sdk";
import type { Synthesis, TranscriptDetail, VoiceCharacter } from "../types";
import { t, tF } from "../i18n";
import { originLabelKey } from "../voice";
import { buildSRT, copyText, downloadBlob, formatTimecode, kindLabel, languageLabel, timestamp } from "../lib/format";
import { engineLabel, speechModels, styleLabel } from "../lib/options";

export function TranscriptOutput({ busy, transcript, onEditSegment, onSave }: { busy: string | null; transcript: TranscriptDetail | null; onEditSegment: (index: number, text: string) => void; onSave: (transcript: TranscriptDetail) => void }) {
  const locale = useRecutLocale();
  const [showSRT, setShowSRT] = useState(false);
  const [copied, setCopied] = useState(false);
  const srt = transcript ? buildSRT(transcript.segments) : "";
  const copy = async () => { if (!transcript) return; if (await copyText(srt)) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } };
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between gap-3 pb-3">
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

export function CharacterPreview({ busy, character, onRemove, onSave }: { busy: string | null; character: VoiceCharacter; onRemove?: () => void; onSave: () => void }) {
  const locale = useRecutLocale();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  return <Card><CardHeader className="pb-2"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><CardTitle className="min-w-0 truncate text-sm">{character.name}</CardTitle><Badge className="shrink-0 text-[10px]" variant="outline">{t(locale, originLabelKey(character.origin))}</Badge></div>{character.sampleAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div><CardDescription className="text-[11px]">{tF(locale, "character.referenceTranscript", { model: character.model.replace("whisper-", ""), time: timestamp(locale, character.createdAt) })}</CardDescription></CardHeader><CardContent className="grid gap-3"><audio className="w-full" controls preload="metadata" src={character.sampleURL} /><div className="grid gap-1"><p className="text-[11px] font-medium text-muted-foreground">{t(locale, "character.prompt.label")}</p><p className="max-h-32 overflow-auto rounded-md bg-muted/60 p-2.5 text-xs leading-relaxed">{character.promptText || t(locale, "character.prompt.missing")}</p></div></CardContent><CardFooter className="justify-between gap-2"><Button disabled={busy !== null || Boolean(character.sampleAssetId)} onClick={onSave} type="button" variant="outline" size="sm"><Save className="size-3.5" />{character.sampleAssetId ? t(locale, "badge.savedInLibrary") : t(locale, "save.referenceAudio")}</Button>{onRemove && <Button disabled={busy !== null || confirmingRemove} onClick={() => { if (confirmingRemove) { onRemove(); } else { setConfirmingRemove(true); } }} type="button" variant={confirmingRemove ? "destructive" : "ghost"} size="sm"><Trash2 className="size-3.5" />{confirmingRemove ? t(locale, "character.confirmRemove") : t(locale, "delete")}</Button>}</CardFooter></Card>;
}

export function SynthesisOutput({ busy, selected, syntheses, onSave }: { busy: string | null; selected: Synthesis | null; syntheses: Synthesis[]; onSave: (synthesis: Synthesis) => void }) {
  const locale = useRecutLocale();
  const current = selected ?? syntheses[0] ?? null;
  return <CardContent className="flex h-full flex-col gap-4">
    <div className="flex items-center justify-between pb-3"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "output.synthesis.eyebrow")}</p><h2 className="mt-0.5 text-sm font-semibold">{t(locale, "output.synthesis.title")}</h2></div>{current && (current.savedAssetId ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.privatePreview")}</Badge>)}</div>
    <div className="grid flex-1 place-items-center">
      {current ? <div className="grid w-full max-w-md gap-3"><div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"><div className="grid gap-0.5"><strong className="text-xs font-medium">{engineLabel(locale, current.engine)} · {t(locale, "synthesis.current")}</strong><small className="text-[11px] text-muted-foreground">{tF(locale, "synthesis.detail", { style: styleLabel(locale, current.style), duration: current.duration.toFixed(1), time: timestamp(locale, current.createdAt) })}</small></div>{current.savedAssetId ? <Check className="size-4 text-primary" /> : null}</div><audio className="w-full" controls src={current.outputURL} /></div> : <div className="grid max-w-60 place-items-center gap-2 text-center text-sm text-muted-foreground"><Sparkles className="size-7 text-muted-foreground/60" /><p>{t(locale, "synthesis.empty")}</p></div>}
    </div>
    {current && <div className="flex items-center justify-between gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">{t(locale, "synthesis.listenHint")}</p>{current.savedAssetId ? <Badge variant="secondary">{t(locale, "badge.savedInLibrary")}</Badge> : <Button disabled={busy !== null} onClick={() => onSave(current)} type="button" size="sm">{busy === "save" ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}{t(locale, "save.toLibrary")}</Button>}</div>}
  </CardContent>;
}
