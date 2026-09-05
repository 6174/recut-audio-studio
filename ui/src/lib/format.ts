/**
 * [INPUT]: 依赖 types（ShellJobLog / TranscriptSegment / ActiveAudioJob / TaskState）与 recut-sdk 的 Locale、i18n
 * [OUTPUT]: 纯工具函数：任务/job 终态判断（isTerminal/TERMINAL_TASK_STATES/isValidActiveJob）、日志合并（logText/mergeLogs）、时间与时长格式化（jobStartedAt/formatElapsed/formatTimecode/timestamp）、SRT 构建（buildSRT）、剪贴板与下载（copyText/downloadBlob）、本地化标签（kindLabel/languageLabel）
 * [POS]: audio-studio UI 的无状态工具层；被 App、任务中心、结果输出与设置面板共同复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import type { Locale } from "../recut-sdk";
import type { ActiveAudioJob, ShellJob, ShellJobLog, TaskState, TranscriptSegment } from "../types";
import { t } from "../i18n";

export function isTerminal(status: ShellJob["status"]) { return status !== "queued" && status !== "running"; }
export const TERMINAL_TASK_STATES = new Set<TaskState>(["completed", "failed", "cancelled", "interrupted"]);
export function isValidActiveJob(job: ActiveAudioJob | null | undefined): job is ActiveAudioJob { return Boolean(job?.id && ["prepare", "install", "transcribe", "character", "design", "synthesize"].includes(job.action) && ["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(job.status)); }
export function logText(logs: ShellJobLog[]) { return logs.map((entry) => entry.text).join(""); }
export function mergeLogs(current: ShellJobLog[], next: ShellJobLog[]) { return [...new Map([...current, ...next].map((entry) => [entry.sequence, entry])).values()].sort((left, right) => left.sequence - right.sequence).slice(-80); }
export function jobStartedAt(startedAt?: string) { const value = Date.parse(startedAt || ""); return Number.isNaN(value) ? Date.now() : value; }
export function formatElapsed(totalSeconds: number) { const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0"); const seconds = (totalSeconds % 60).toString().padStart(2, "0"); return `${minutes}:${seconds}`; }
export function formatTimecode(seconds: number) { const milliseconds = Math.max(0, Math.round(seconds * 1000)); const hours = Math.floor(milliseconds / 3600000).toString().padStart(2, "0"); const minutes = Math.floor((milliseconds % 3600000) / 60000).toString().padStart(2, "0"); const secs = Math.floor((milliseconds % 60000) / 1000).toString().padStart(2, "0"); const millis = (milliseconds % 1000).toString().padStart(3, "0"); return `${hours}:${minutes}:${secs},${millis}`; }
export function buildSRT(segments: TranscriptSegment[]) { return segments.map((segment, index) => `${index + 1}\n${formatTimecode(segment.start)} --> ${formatTimecode(segment.end)}\n${segment.text}`).join("\n\n") + "\n"; }
export async function copyText(text: string) { try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; } }
export function downloadBlob(name: string, content: string, mimeType: string) { const blob = new Blob([content], { type: mimeType }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
export function timestamp(locale: Locale, createdAt: string) { return new Date(createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US"); }
export function kindLabel(locale: Locale, kind: string) { return kind === "audio" ? t(locale, "kind.audio") : kind === "video" ? t(locale, "kind.video") : kind; }
export function languageLabel(locale: Locale, language: string) { return language === "auto" ? t(locale, "language.auto") : language === "zh" ? t(locale, "language.zh") : language === "en" ? t(locale, "language.en") : language; }
