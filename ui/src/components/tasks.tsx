/**
 * [INPUT]: 依赖 shadcn/ui Card/Badge/Button、lucide 图标、recut-sdk、i18n、components/results 的三个结果输出件与 lib/format（formatElapsed/copyText/downloadBlob）
 * [OUTPUT]: 左侧任务中心 TaskCenter（按日分组 + 状态筛选，含排队中）与 TaskRow（状态徽标 + 停止按钮）、右侧 TaskDetail（任务元信息 + 日志复制/下载 + 结果卡内联渲染转写/角色/配音产物）
 * [POS]: audio-studio 主界面左右两栏；选择与取消动作经回调交回 App 编排层
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { Check, ChevronRight, CircleStop, Copy, Download, Filter, MessageSquareText, Mic, Sparkles, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useRecutLocale, type Locale } from "../recut-sdk";
import type { Synthesis, TaskLogEntry, TaskState, TaskSummary, TranscriptDetail, VoiceCharacter } from "../types";
import { t } from "../i18n";
import { copyText, downloadBlob, formatElapsed } from "../lib/format";
import { CharacterPreview, SynthesisOutput, TranscriptOutput } from "./results";

function taskStateLabel(locale: Locale, state: TaskState): string {
  if (state === "running") return t(locale, "task.state.running");
  if (state === "queued") return t(locale, "task.state.queued");
  if (state === "completed") return t(locale, "task.state.done");
  if (state === "failed") return t(locale, "task.state.failed");
  if (state === "cancelled") return t(locale, "task.state.cancelled");
  return t(locale, "task.state.interrupted");
}

export function TaskCenter({ tasks, filter, selectedTask, onFilter, onSelect, onCancelTask }: { tasks: TaskSummary[]; filter: "all" | "running" | "queued" | "completed" | "failed"; selectedTask: TaskSummary | null; onFilter: (filter: "all" | "running" | "queued" | "completed" | "failed") => void; onSelect: (task: TaskSummary) => void; onCancelTask: (id: string) => void }) {
  const locale = useRecutLocale();
  const groups = new Map<string, TaskSummary[]>();
  tasks.forEach((task) => { const date = task.createdAt.slice(0, 10); groups.set(date, [...(groups.get(date) ?? []), task]); });
  const filters: { id: "all" | "running" | "queued" | "completed" | "failed"; label: string }[] = [
    { id: "all", label: t(locale, "task.filter.all") },
    { id: "running", label: t(locale, "task.filter.running") },
    { id: "queued", label: t(locale, "task.filter.queued") },
    { id: "completed", label: t(locale, "task.state.done") },
    { id: "failed", label: t(locale, "task.state.failed") },
  ];
  return <Card className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-4">
      <h2 className="text-base font-semibold">{t(locale, "task.listTitle")}</h2>
      <div className="flex min-w-0 items-center gap-1 rounded-full bg-muted/60 p-0.5"><Filter className="ml-2 size-3.5 shrink-0 text-muted-foreground" />{filters.map((item) => <Button className={cn("h-7 rounded-full border-0 px-3 text-xs", filter === item.id ? "bg-background text-foreground shadow-xs hover:bg-background" : "bg-transparent text-muted-foreground hover:bg-background/50 hover:text-foreground")} key={item.id} onClick={() => onFilter(item.id)} size="sm" type="button" variant="ghost">{item.label}</Button>)}</div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {tasks.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t(locale, "task.empty")}</p>}
      {[...groups.entries()].map(([date, items]) => <div key={date}>
        <div className="flex items-center gap-3 px-2 py-2"><span className="shrink-0 font-mono text-[11px] font-medium tracking-wide text-muted-foreground">{date}</span><span className="h-px flex-1 bg-border/70" /></div>
        {items.map((task) => <TaskRow key={task.id} onCancel={onCancelTask} onSelect={onSelect} selected={selectedTask?.id === task.id} task={task} />)}
      </div>)}
    </div>
  </Card>;
}

function TaskRow({ task, selected, onSelect, onCancel }: { task: TaskSummary; selected: boolean; onSelect: (task: TaskSummary) => void; onCancel: (id: string) => void }) {
  const locale = useRecutLocale();
  const active = task.state === "running" || task.state === "queued";
  const failed = task.state === "failed";
  const completed = task.state === "completed";
  const icon = task.action === "install" ? <Download className="size-3.5" /> : task.action === "transcribe" ? <MessageSquareText className="size-3.5" /> : task.action === "character" || task.action === "design" ? <Mic className="size-3.5" /> : <Sparkles className="size-3.5" />;
  const iconTone = failed ? "bg-destructive/15 text-destructive" : active ? "bg-sky-500/15 text-sky-400" : "bg-primary/15 text-primary";
  return <div className={cn("mb-2 flex w-full items-center gap-1 rounded-xl border px-1 transition-colors", selected ? "border-primary bg-primary/5" : "border-border/60 bg-background/20 hover:border-border hover:bg-background/35")}>
    <button className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2.5 text-left" onClick={() => onSelect(task)} type="button">
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", iconTone)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.name}</span>
          <span className="text-[11px] text-muted-foreground">{new Date(task.createdAt).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}</span>
        </span>
        <span className="mt-1.5 flex items-center gap-1.5">
          <Badge className="rounded-full border-0 bg-muted px-2 py-0 text-[11px] font-normal leading-none text-muted-foreground">{task.source === "ai" ? t(locale, "task.source.ai") : t(locale, "task.source.manual")}</Badge>
          <Badge className={cn("rounded-full border-0 px-2 py-0 text-[11px] font-normal leading-none", failed ? "bg-destructive/15 text-destructive" : completed ? "bg-primary/15 text-primary" : active ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground")}>{taskStateLabel(locale, task.state)}</Badge>
        </span>
      </span>
      {selected && <ChevronRight className="size-4 shrink-0 text-primary" />}
    </button>
    {active && <button aria-label={t(locale, "bottom.stop")} className="mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => onCancel(task.id)} type="button"><CircleStop className="size-3.5" /></button>}
  </div>;
}

export function TaskDetail({ busy, selectedTask, logs, result, onEditSegment, onSaveCharacter, onSaveTranscript, onSaveSynthesis }: { busy: string | null; selectedTask: TaskSummary | null; logs: TaskLogEntry[]; result: { kind: "transcript" | "character" | "synthesis"; item: TranscriptDetail | VoiceCharacter | Synthesis } | null; onEditSegment: (index: number, text: string) => void; onSaveCharacter: (character: VoiceCharacter) => void; onSaveTranscript: (transcript: TranscriptDetail) => void; onSaveSynthesis: (synthesis: Synthesis) => void }) {
  const locale = useRecutLocale();
  if (!selectedTask) return <Card className="grid h-full min-h-0 place-items-center"><p className="px-4 text-center text-sm text-muted-foreground">{t(locale, "task.detailEmpty")}</p></Card>;
  const duration = (()=>{ try{ const s=new Date(selectedTask.createdAt).getTime(); return formatElapsed(Math.max(0,Math.floor((Date.now()-s)/1000))); }catch{return "--:--";}})();
  const resultSaved = result ? result.kind === "character" ? Boolean((result.item as VoiceCharacter).sampleAssetId) : Boolean((result.item as TranscriptDetail | Synthesis).savedAssetId) : false;
  return <div className="grid h-full min-h-0 content-start gap-4 overflow-y-auto pr-1">
    <Card>
      <div className="flex items-start justify-between gap-2 px-4 py-3.5 border-0">
        <div className="min-w-0"><h2 className="text-base font-semibold truncate">{selectedTask.name}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cn("size-1.5 rounded-full", selectedTask.state==="completed"?"bg-green-500":selectedTask.state==="failed"?"bg-red-500":"bg-amber-500")} />{taskStateLabel(locale, selectedTask.state)}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">ID: {selectedTask.id} <button onClick={()=>void copyText(selectedTask.id)} className="rounded p-0.5 hover:bg-muted"><Copy className="size-3" /></button></p>
          {selectedTask.action === "design" ? <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Wand2 className="size-3 text-primary" />{t(locale, "task.action.design")}{selectedTask.meta?.presetId ? ` · presetId: ${String(selectedTask.meta.presetId)}` : selectedTask.meta?.designDesc ? ` · ${String(selectedTask.meta.designDesc)}` : ""}</p> : null}
        </div>
        <div className="shrink-0 text-right"><p className="text-xs text-muted-foreground">{new Date(selectedTask.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</p><p className="text-[11px] text-muted-foreground">时长 {duration}</p></div>
      </div>
      <div className="grid gap-3 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between"><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">LOGS</p><span className="flex gap-1"><Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={()=>void copyText(logs.map(e=>e.message).join("\n"))}><Copy className="size-3" />复制</Button><Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={()=>downloadBlob(`logs-${selectedTask.id}.txt`,logs.map(e=>e.message).join("\n"),"text/plain")}><Download className="size-3" />下载</Button></span></div>
          <pre className="max-h-64 overflow-auto rounded-xl border-0 bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg">{logs.length ? logs.map((entry) => `${entry.ts ? "[" + entry.ts + "] " : ""}${entry.message}`).join("\n") : t(locale, "task.logsEmpty")}</pre>
        </div>
      </div>
    </Card>
    {result && <Card>
      <div className="flex items-center justify-between px-4 py-2.5"><p className="text-sm font-medium">{t(locale, "task.resultTitle")}</p>{resultSaved ? <Badge variant="secondary"><Check className="mr-1 size-3" />{t(locale, "badge.saved")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div>
      <div className="px-4 pb-4">
      {result.kind === "transcript" ? <TranscriptOutput busy={busy} onEditSegment={onEditSegment} onSave={onSaveTranscript} transcript={result.item as TranscriptDetail} />
        : result.kind === "character" ? <CharacterPreview busy={busy} character={result.item as VoiceCharacter} onSave={() => onSaveCharacter(result.item as VoiceCharacter)} />
        : <SynthesisOutput busy={busy} onSave={onSaveSynthesis} selected={result.item as Synthesis} syntheses={[result.item as Synthesis]} />}
      <div className="mt-3 flex items-center justify-between text-xs"><p className="text-[11px] text-muted-foreground">{resultSaved ? t(locale, "badge.savedInLibrary") : t(locale, "badge.privatePreview")}</p>{resultSaved ? <Badge variant="secondary">{t(locale, "badge.savedInLibrary")}</Badge> : <Badge variant="outline">{t(locale, "badge.private")}</Badge>}</div>
      </div>
    </Card>}
  </div>;
}
