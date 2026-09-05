/**
 * [INPUT]: 依赖 shadcn/ui Card、lucide 图标、recut-sdk、i18n 与 lib/format（formatElapsed/logText）
 * [OUTPUT]: Setup 首启引导卡：环境未就绪时自动触发全量 audio.prepare，展示计时、实时日志与失败诊断（含「问 Agent」入口）
 * [POS]: audio-studio 的启动门；status.ready 之前整屏渲染此卡
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { useEffect, useRef } from "react";
import { Clock3, Download, LoaderCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useRecutLocale } from "../recut-sdk";
import type { ShellJobLog } from "../types";
import { t, tF } from "../i18n";
import { formatElapsed, logText } from "../lib/format";

export function Setup({ autoPrepare, busy, elapsedSeconds, failure, failureLogs, logs, message, pythonVersion, onPrepare, onAskAgent }: { autoPrepare: boolean; busy: string | null; elapsedSeconds: number; failure: string; failureLogs: ShellJobLog[]; logs: ShellJobLog[]; message: string; pythonVersion?: string; onPrepare: () => void; onAskAgent: () => void }) {
  const locale = useRecutLocale();
  const started = useRef(false);
  useEffect(() => { if (autoPrepare && !started.current) { started.current = true; onPrepare(); } }, [autoPrepare, onPrepare]);
  const failureText = failureLogs.length ? failureLogs.map((entry) => entry.text).join("") : "";
  return <div className="mx-auto mt-[10vh] w-full max-w-lg">
    <Card>
      <CardHeader>
        <div className="mb-2 grid size-10 place-items-center rounded-md border bg-accent text-primary"><LoaderCircle className={cn("size-5", busy === "prepare" && "animate-spin")} /></div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{t(locale, "app.title")}</p>
        <CardTitle className="mt-1">{t(locale, "setup.title")}</CardTitle>
        <CardDescription>{t(locale, "setup.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {busy === "prepare" && <><div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-primary"><Clock3 className="size-3.5" />{tF(locale, "setup.runningLabel", { time: formatElapsed(elapsedSeconds) })}</div><pre className="max-h-56 overflow-auto rounded-md bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg" aria-label={t(locale, "aria.setupPrep")}>{logs.length ? logText(logs) : t(locale, "setup.prepLogsLabel")}</pre></>}
        {failure && <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"><strong className="text-sm">{t(locale, "setup.failureTitle")}</strong><p className="break-all leading-relaxed text-destructive">{failure}</p>{pythonVersion && <p className="text-[11px] text-muted-foreground">{tF(locale, "setup.pythonHint", { version: pythonVersion })}</p>}{failureText && <pre className="max-h-56 overflow-auto rounded-md bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-fg" aria-label={t(locale, "aria.failureLogs")}>{failureText}</pre>}<div className="flex gap-2"><Button disabled={busy !== null} onClick={onAskAgent} type="button" variant="outline" size="sm" className="w-fit text-destructive"><Send className="size-3.5" />{t(locale, "setup.askAgent")}</Button></div></div>}
      </CardContent>
      <CardFooter className="flex-col items-start gap-2">
        <Button disabled={busy !== null} onClick={onPrepare} type="button" variant="outline">{busy === "prepare" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}{busy === "prepare" ? t(locale, "msg.starting") : t(locale, "setup.retry")}</Button>
        <p className="text-xs text-muted-foreground" role="status">{message}</p>
      </CardFooter>
    </Card>
  </div>;
}
