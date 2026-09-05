/**
 * [INPUT]: 依赖 lucide 图标、shadcn/ui 无关（纯 button 样式经 cn）、recut-sdk、i18n 与 lib/options 的 Tab 类型
 * [OUTPUT]: LauncherBar：三张工作流入口卡（转写 / 声音角色 / 配音合成），带选中态与该功能的进行中/排队中徽标
 * [POS]: audio-studio 顶部的功能导航；点击卡片打开对应工作流模态框
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import type { ReactNode } from "react";
import { ArrowRight, LoaderCircle, MessageSquareText, Mic, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRecutLocale } from "../recut-sdk";
import { t } from "../i18n";
import type { Tab } from "../lib/options";

export function LauncherBar({ active, onLaunch, states }: { active: Tab; onLaunch: (tab: Tab) => void; states: Record<Tab, "running" | "queued" | null> }) {
  const locale = useRecutLocale();
  const cards: { id: Tab; icon: ReactNode; title: string; subtitle: string; desc: string }[] = [
    { id: "transcribe", icon: <MessageSquareText className="size-5" />, title: t(locale, "nav.transcribe.label"), subtitle: "音视频 → 文稿与字幕", desc: "支持多种格式转写，智能说话人分离" },
    { id: "characters", icon: <Mic className="size-5" />, title: t(locale, "nav.characters.label"), subtitle: "参考音 → 专属声纹", desc: "上传参考音频，克隆你的专属声音" },
    { id: "synthesize", icon: <Sparkles className="size-5" />, title: t(locale, "nav.synthesize.label"), subtitle: "文本 → 声音演绎", desc: "选择角色，输入文本，一键生成配音" },
  ];
  return <div className="mt-2 grid shrink-0 grid-cols-1 gap-3 min-[640px]:grid-cols-3">
    {cards.map((item) => {
      const selected = active === item.id;
      const state = states[item.id];
      return <button aria-pressed={selected} className={cn("group flex min-h-28 items-center gap-3 rounded-2xl border p-3 text-left shadow-none transition-colors", selected ? "border-primary/60 bg-primary/10" : "border-border/70 bg-card hover:border-border hover:bg-card")} key={item.id} onClick={() => onLaunch(item.id)} type="button">
        <span className={cn("grid size-12 shrink-0 place-items-center rounded-xl", selected ? "bg-primary text-primary-foreground shadow-[0_8px_24px_rgba(34,197,94,0.16)]" : "bg-muted text-foreground")}>{item.icon}</span>
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex items-center gap-2 text-sm font-semibold leading-none">{item.title}{state && <span className={cn("flex items-center gap-1 text-[10px] font-normal", state === "running" ? "text-primary" : "text-amber-600")}><LoaderCircle className={cn("size-3", state === "running" && "animate-spin")} />{t(locale, state === "running" ? "task.state.running" : "task.state.queued")}</span>}</span>
          <span className="truncate text-[11px] font-medium leading-none text-foreground/80">{item.subtitle}</span>
          <span className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{item.desc}</span>
        </span>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-full border transition-transform group-hover:translate-x-0.5", selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card")}><ArrowRight className="size-3.5" /></span>
      </button>;
    })}
  </div>;
}
