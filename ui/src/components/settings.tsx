/**
 * [INPUT]: 依赖 shadcn/ui Badge/Button/Label/Select、lucide 图标、recut-sdk、i18n、lib/format（TERMINAL_TASK_STATES）、lib/options（speechModels/downloadSources/voxcpmVersions）与 components/workflow 的 ControlSection
 * [OUTPUT]: 右上角「模型与环境」设置面板：ResourceRow（名称+就绪徽标+错误+下载动作）、SettingsDialog（运行环境主/CosyVoice/VoxCPM + ASR/TTS 模型下载 + 下载源 + 声音预设状态；按行禁用，互不锁定）与 DownloadSourceSelect
 * [POS]: audio-studio 全部安装/下载动作的集中入口；focus 控制打开后滚动到对应分区
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { useEffect, useRef } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useRecutLocale } from "../recut-sdk";
import type { DownloadSource, RuntimeStatus, SpeechModel, TaskState, TaskSummary, VoicePreset, VoxCpmVersion } from "../types";
import { t, tF, type I18nKey } from "../i18n";
import { TERMINAL_TASK_STATES } from "../lib/format";
import { downloadSources, speechModels, voxcpmVersions } from "../lib/options";
import { ControlSection } from "./workflow";

// 设置面板的资源行：名称 + 状态徽标 + 错误 + 动作按钮。
function ResourceRow({ title, meta, ready, error, actionLabel, onAction, disabled, secondary }: { title: string; meta: string; ready: boolean; error?: string | null; actionLabel: string; onAction: () => void; disabled: boolean; secondary?: boolean }) {
  const locale = useRecutLocale();
  return <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border px-3 py-2.5">
    <div className="grid min-w-0 gap-0.5">
      <span className="flex items-center gap-2 text-xs font-medium">{title}<span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px]", ready ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-600")}>{ready ? t(locale, "settings.env.ready") : t(locale, "settings.env.missing")}</span></span>
      <small className="truncate text-[11px] text-muted-foreground" title={meta}>{meta}</small>
      {!ready && error && <p className="truncate text-[11px] text-destructive" title={error}>{error}</p>}
    </div>
    <Button disabled={disabled} onClick={onAction} size="sm" type="button" variant={secondary ? "ghost" : "outline"} className="shrink-0"><Download className="size-3.5" />{actionLabel}</Button>
  </div>;
}

function DownloadSourceSelect({ disabled, source, onChange }: { disabled: boolean; source: DownloadSource; onChange: (value: DownloadSource) => void }) {
  const locale = useRecutLocale();
  const selected = downloadSources.find((item) => item.id === source);
  return <div className="grid gap-2">
    <Label htmlFor="download-source" className="text-xs text-muted-foreground">{t(locale, "downloadSource.label")}</Label>
    <Select disabled={disabled} onValueChange={(value) => onChange(value as DownloadSource)} value={source}>
      <SelectTrigger id="download-source" className="h-9 w-full min-w-0"><SelectValue placeholder={t(locale, "downloadSource.placeholder")} /></SelectTrigger>
      <SelectContent>{downloadSources.map((item) => <SelectItem key={item.id} value={item.id}>{t(locale, item.labelKey)}</SelectItem>)}</SelectContent>
    </Select>
    {selected && <p className="text-[11px] leading-relaxed text-muted-foreground">{t(locale, selected.noteKey)}</p>}
  </div>;
}

// 右上角「模型与环境」面板：运行环境（主/CosyVoice/VoxCPM）+ ASR/TTS 模型 + 下载源 + 声音预设状态。
// 全部安装/下载动作集中于此；工作流步骤只保留就绪引导。
export function SettingsDialog({ status, activeTasks, downloadSource, presets, focus, onInstallAsr, onInstallCosyVoice, onInstallVoxCpm, onPrepareTarget, onSetDownloadSource }: { status: RuntimeStatus; activeTasks: TaskSummary[]; downloadSource: DownloadSource; presets: VoicePreset[]; focus: "environment" | "asr" | "tts"; onInstallAsr: (model: SpeechModel) => void; onInstallCosyVoice: () => void; onInstallVoxCpm: (version: VoxCpmVersion) => void; onPrepareTarget: (target: "all" | "cosyvoice" | "voxcpm") => void; onSetDownloadSource: (source: DownloadSource) => void }) {
  const locale = useRecutLocale();
  const environmentRef = useRef<HTMLDivElement | null>(null);
  const asrRef = useRef<HTMLDivElement | null>(null);
  const ttsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const target = focus === "asr" ? asrRef.current : focus === "tts" ? ttsRef.current : environmentRef.current;
    target?.scrollIntoView({ block: "start" });
  }, [focus]);
  const localeNote = (key: I18nKey) => t(locale, key);
  const engines = status.tts?.engines;
  const installed = new Set(status.asr?.installed ?? []);
  // 按行禁用（RFC task-queue）：每行只被自己的在途任务禁用（该 target 的 prepare / 该模型的 install），互不锁。
  const isActive = (task: TaskSummary) => !TERMINAL_TASK_STATES.has(task.state);
  const prepareBusy = (targets: string[]) => activeTasks.find((task) => task.action === "prepare" && isActive(task) && targets.includes(String(task.meta.target || "all")));
  const installBusy = (model: string) => activeTasks.find((task) => task.action === "install" && isActive(task) && task.meta.model === model);
  const busyLabel = (state: TaskState) => t(locale, state === "running" ? "settings.busy" : "task.state.queued");
  const envMain = prepareBusy(["all"]);
  const envCosy = prepareBusy(["cosyvoice", "all"]);
  const envVox = prepareBusy(["voxcpm", "all"]);
  const headerBusy = envMain ?? envCosy ?? envVox ?? activeTasks.find((task) => task.action === "install" && isActive(task));
  const downloadLocked = activeTasks.some((task) => task.action === "install" && isActive(task) && task.state === "running");
  const cosyvoice2 = engines?.cosyvoice2;
  const cosyvoiceEnv = engines?.cosyvoice2?.runtime ?? false;
  const voxcpmEngine = engines?.voxcpm ?? null;
  const pythonVersion = status.pythonVersion ? `Python ${status.pythonVersion}` : "";
  return <div className="grid gap-5">
    {headerBusy && <p className="flex items-center gap-1.5 text-xs font-medium text-sky-500"><LoaderCircle className={cn("size-3.5", headerBusy.state === "running" && "animate-spin")} />{t(locale, "settings.busy")}</p>}
    <div ref={environmentRef} className="scroll-mt-2"><ControlSection eyebrow={t(locale, "settings.eyebrow.environment")} title={t(locale, "settings.environment.title")}>
      <div className="grid gap-2">
        <ResourceRow title={t(locale, "settings.env.main")} meta={`${pythonVersion ? pythonVersion + " · " : ""}${t(locale, "settings.env.main.note")}`} ready actionLabel={envMain ? busyLabel(envMain.state) : t(locale, "settings.env.reinstall")} disabled={Boolean(envMain)} onAction={() => onPrepareTarget("all")} secondary />
        <ResourceRow title={t(locale, "settings.env.cosyvoice")} meta={t(locale, "settings.env.cosyvoice.note")} ready={cosyvoiceEnv} error={cosyvoice2?.runtimeError ?? null} actionLabel={envCosy ? busyLabel(envCosy.state) : (cosyvoiceEnv ? t(locale, "settings.env.reinstall") : t(locale, "settings.env.install"))} disabled={Boolean(envCosy)} onAction={() => onPrepareTarget("cosyvoice")} secondary={cosyvoiceEnv} />
        <ResourceRow title={t(locale, "settings.env.voxcpm")} meta={t(locale, "settings.env.voxcpm.note")} ready={Boolean(voxcpmEngine?.runtime)} error={voxcpmEngine?.runtimeError ?? null} actionLabel={envVox ? busyLabel(envVox.state) : (voxcpmEngine?.runtime ? t(locale, "settings.env.reinstall") : t(locale, "settings.env.install"))} disabled={Boolean(envVox)} onAction={() => onPrepareTarget("voxcpm")} secondary={Boolean(voxcpmEngine?.runtime)} />
      </div>
    </ControlSection></div>
    <div ref={asrRef} className="scroll-mt-2"><ControlSection eyebrow={t(locale, "settings.eyebrow.asr")} title={t(locale, "settings.asr.title")}>
      <div className="grid gap-2">
        {speechModels.map((item) => { const row = installBusy(item.id); return <ResourceRow key={item.id} title={item.label} meta={localeNote(item.noteKey)} ready={installed.has(item.id)} actionLabel={row ? busyLabel(row.state) : t(locale, "settings.model.download")} disabled={Boolean(row)} onAction={() => onInstallAsr(item.id)} />; })}
      </div>
    </ControlSection></div>
    <div ref={ttsRef} className="scroll-mt-2"><ControlSection eyebrow={t(locale, "settings.eyebrow.tts")} title={t(locale, "settings.tts.title")}>
      <div className="grid gap-2">
        {(() => { const row = installBusy("cosyvoice2"); return <ResourceRow title={t(locale, "engine.label.cosyvoice2")} meta={t(locale, "settings.cosyvoice.meta")} ready={Boolean(cosyvoice2?.ready)} error={cosyvoice2?.runtimeError ?? null} actionLabel={row ? busyLabel(row.state) : (cosyvoice2?.ready ? t(locale, "settings.env.reinstall") : t(locale, "settings.model.download"))} disabled={Boolean(row)} onAction={onInstallCosyVoice} secondary={Boolean(cosyvoice2?.ready)} />; })()}
        {voxcpmVersions.map((item) => {
          const model = voxcpmEngine?.models[item.id] ?? null;
          const meta = `${t(locale, item.noteKey)} · ${tF(locale, "voxcpm.size", { size: (model?.sizeGb ?? 0).toFixed(1) })}`;
          const ready = Boolean(model?.ready);
          const row = installBusy(item.id);
          return <ResourceRow key={item.id} title={t(locale, item.labelKey)} meta={meta} ready={ready} error={ready ? null : (voxcpmEngine?.runtime ? t(locale, "controls.voxcpm.missing") : (voxcpmEngine?.runtimeError ?? t(locale, "voxcpm.runtimeMissing")))} actionLabel={row ? busyLabel(row.state) : (ready ? t(locale, "settings.env.reinstall") : t(locale, "settings.model.download"))} disabled={Boolean(row)} onAction={() => onInstallVoxCpm(item.id)} secondary={ready} />;
        })}
      </div>
    </ControlSection></div>
    <ControlSection eyebrow="" title={t(locale, "downloadSource.label")}>
      <DownloadSourceSelect disabled={downloadLocked} source={downloadSource} onChange={(source) => onSetDownloadSource(source)} />
    </ControlSection>
    <ControlSection eyebrow="" title={t(locale, "settings.presets.title")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={status.presets?.cdnReachable ? "secondary" : "outline"}>{t(locale, status.presets?.cdnReachable ? "settings.presets.cdn" : "settings.presets.offline")}</Badge>
        {presets.length > 0 && status.presets && <Badge variant="outline">{tF(locale, "settings.presets.cached", { count: status.presets.cached.length })} / {presets.length}</Badge>}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t(locale, "settings.presets.hint")}</p>
    </ControlSection>
  </div>;
}
