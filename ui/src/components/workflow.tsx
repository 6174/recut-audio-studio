/**
 * [INPUT]: 依赖 shadcn/ui 组件（Button/Label/Select/Input）、lucide 图标、recut-sdk、i18n 与 lib/options、lib/format
 * [OUTPUT]: 跨工作流通用的 UI 件：DialogCard（无遮罩层叠模态框，base/top 两级 + 返回按钮）、ControlSection（eyebrow + 标题分区）、StepFooter（分步进度点 + 上一步/下一步/完成）、SourceButtons（素材库选择 + 本地上传）、SelectedSource（已选素材的音视频预览卡）、ModelSelect（ASR 模型下拉）
 * [POS]: audio-studio UI 的共享控件层；转写/克隆控件与各模态框共同复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import type { ReactNode } from "react";
import { ChevronLeft, FolderOpen, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useRecutLocale } from "../recut-sdk";
import type { MediaAsset, SpeechModel } from "../types";
import { t, tF } from "../i18n";
import { speechModels } from "../lib/options";
import { kindLabel } from "../lib/format";

export function DialogCard({ title, onClose, children, headerAction, level = "base", onBack }: { title: string; onClose: () => void; children: ReactNode; headerAction?: ReactNode; level?: "base" | "top"; onBack?: () => void }) {
  const locale = useRecutLocale();
  return <div className={cn("fixed inset-0 grid place-items-center bg-black/60 p-4 backdrop-blur-[2px]", level === "top" ? "z-[60]" : "z-50")} onClick={onClose}>
    <div className="flex max-h-[min(760px,calc(100dvh-32px))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-5 py-4">
        <div className="flex min-w-0 items-center gap-1.5">
          {onBack && <Button aria-label={t(locale, "characters.backEntries")} onClick={onBack} type="button" variant="ghost" size="icon"><ChevronLeft className="size-4" /></Button>}
          <h2 className="truncate text-sm font-semibold">{title}</h2>
        </div>
        <div className="flex items-center gap-2">{headerAction}<Button aria-label="close" onClick={onClose} type="button" variant="ghost" size="icon"><X className="size-4" /></Button></div>
      </div>
      <div className="min-h-0 overflow-y-auto p-5">{children}</div>
    </div>
  </div>;
}

export function ControlSection({ title, eyebrow, children }: { title: string; eyebrow?: string; children: ReactNode }) {
  return <section className="grid gap-3"><div>{eyebrow && <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>}<h2 className={cn("text-sm font-semibold", !eyebrow && "mt-0")}>{title}</h2></div>{children}</section>;
}

export function StepFooter({ step, total, busy, onBack, onNext, onFinish, finishDisabled, finishLabel }: { step: number; total: number; busy: string | null; onBack: () => void; onNext: () => void; onFinish: () => void; finishDisabled: boolean; finishLabel: ReactNode }) {
  const locale = useRecutLocale();
  const disabled = busy !== null;
  return <div className="flex items-center justify-between gap-3 border-t pt-4">
    <div className="flex gap-1.5">{Array.from({ length: total }).map((_, index) => <span className={cn("h-1.5 w-6 rounded-full", index <= step ? "bg-primary" : "bg-muted")} key={index} />)}</div>
    <div className="flex items-center gap-2">
      {step > 0 && <Button className="min-w-20" disabled={disabled} onClick={onBack} type="button" variant="ghost">{t(locale, "stepper.back")}</Button>}
      {step < total - 1
        ? <Button className="min-w-24" disabled={disabled} onClick={onNext} type="button">{t(locale, "stepper.next")}</Button>
        : <Button className="min-w-32" disabled={disabled || finishDisabled} onClick={onFinish} type="button" size="lg">{finishLabel}</Button>}
    </div>
  </div>;
}

export function ModelSelect({ disabled, model, onChange }: { disabled: boolean; model: SpeechModel; onChange: (value: SpeechModel) => void }) {
  const locale = useRecutLocale();
  return <div className="grid gap-2">
    <Label htmlFor="speech-model" className="text-xs text-muted-foreground">{t(locale, "modelSelect.label")}</Label>
    <Select disabled={disabled} onValueChange={(value) => onChange(value as SpeechModel)} value={model}>
      <SelectTrigger id="speech-model" className="h-9 w-full min-w-0"><SelectValue placeholder={t(locale, "modelSelect.placeholder")} /></SelectTrigger>
      <SelectContent>{speechModels.map((item) => <SelectItem key={item.id} value={item.id}>{item.label} · {t(locale, item.noteKey)}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

export function SourceButtons({ busy, onChoose, selectedLabel, onUpload, media }: { busy: boolean; onChoose: () => void; selectedLabel: string; onUpload: (file: File | undefined) => void; media?: boolean }) {
  const locale = useRecutLocale();
  const accept = media ? "audio/*,video/*" : "audio/*";
  return <div className="grid gap-2">
    <Label className="text-xs text-muted-foreground">{t(locale, "library.label")}</Label>
    <Button disabled={busy} onClick={onChoose} type="button" variant="outline"><FolderOpen className="size-3.5" />{selectedLabel}</Button>
    <Label className="relative inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium shadow-xs transition-colors hover:bg-input/50 disabled:pointer-events-none disabled:opacity-50"><Upload className="size-3.5" />{media ? t(locale, "upload.media") : t(locale, "upload.audio")}<input accept={accept} className="sr-only" disabled={busy} onChange={(event) => onUpload(event.target.files?.[0])} type="file" /></Label>
  </div>;
}

export function SelectedSource({ asset }: { asset: MediaAsset }) {
  const locale = useRecutLocale();
  const source = `/v1/media/assets/${encodeURIComponent(asset.id)}/content`;
  return <figure className="overflow-hidden rounded-md border bg-muted/40">
    <div className="grid place-items-center bg-muted">{asset.kind === "video" ? <video className="aspect-video w-full object-cover" controls preload="metadata" src={source} /> : <audio className="w-full" controls preload="metadata" src={source} />}</div>
    <figcaption className="grid gap-0.5 px-2.5 py-2"><strong className="truncate text-xs">{asset.name}</strong><span className="text-[10px] text-muted-foreground">{tF(locale, "source.selected", { kind: kindLabel(locale, asset.kind) })}</span></figcaption>
  </figure>;
}
