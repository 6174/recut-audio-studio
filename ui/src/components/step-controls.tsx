/**
 * [INPUT]: 依赖 shadcn/ui 组件、lucide 图标、recut-sdk、i18n、lib/options 与 components/workflow 的 ControlSection/StepFooter/ModelSelect/SourceButtons/SelectedSource
 * [OUTPUT]: 转写与声音角色两个工作流的分步控件：TranscribeControls（素材 → ASR 模型 → 语言，三步）、CharacterControls（参考音 + 角色名 → ASR 模型，两步）；未就绪模型给设置引导
 * [POS]: audio-studio 配音/转写工作流的步骤内表单；提交动作经回调交回 App 编排层
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { Check, LoaderCircle, MessageSquareText, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useRecutLocale } from "../recut-sdk";
import type { Language, MediaAsset, SpeechModel } from "../types";
import { t } from "../i18n";
import { languages } from "../lib/options";
import { ControlSection, ModelSelect, SelectedSource, SourceButtons, StepFooter } from "./workflow";

export function TranscribeControls({ busy, language, model, readySpeechModel, setLanguage, setModel, sourceAsset, upload, onChoose, onRun, onOpenSettings, step, onBack, onNext }: { busy: string | null; language: Language; model: SpeechModel; readySpeechModel: boolean; setLanguage: (value: Language) => void; setModel: (value: SpeechModel) => void; sourceAsset: MediaAsset | null; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onOpenSettings: (focus: "environment" | "asr" | "tts") => void; step: number; onBack: () => void; onNext: () => void }) {
  const locale = useRecutLocale();
  const total = 3;
  return <div className="flex flex-col gap-6">
    {step === 0 && <ControlSection eyebrow={t(locale, "controls.input.eyebrow")} title={t(locale, "controls.input.sourceTitle")}>
      <SourceButtons busy={busy !== null} media onChoose={onChoose} onUpload={upload} selectedLabel={sourceAsset ? t(locale, "source.change") : t(locale, "source.pick.media")} />
      {sourceAsset && <SelectedSource asset={sourceAsset} />}
    </ControlSection>}
    {step === 1 && <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.model.weightsTitle")}>
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "downloaded")}</p> : <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><p className="text-amber-600">{t(locale, "controls.model.missing")}</p><Button disabled={busy !== null} onClick={() => onOpenSettings("asr")} type="button" variant="outline" size="sm" className="w-fit">{t(locale, "settings.open")}</Button></div>}
    </ControlSection>}
    {step === 2 && <ControlSection eyebrow={t(locale, "controls.language.eyebrow")} title={t(locale, "controls.language.title")}>
      <div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/50 p-1">{languages.map((item) => <Button className={cn(language === item.id && "bg-background text-foreground shadow-xs hover:bg-background")} disabled={busy !== null} key={item.id} onClick={() => setLanguage(item.id)} type="button" variant="ghost" size="sm">{t(locale, item.labelKey)}</Button>)}</div>
    </ControlSection>}
    <StepFooter busy={busy} finishDisabled={busy !== null || !sourceAsset || !readySpeechModel} finishLabel={busy === "transcribe" ? <><LoaderCircle className="size-4 animate-spin" />{t(locale, "nav.transcribe.label")}</> : <><MessageSquareText className="size-4" />{t(locale, "nav.transcribe.label")}</>} onBack={onBack} onFinish={onRun} onNext={onNext} step={step} total={total} />
  </div>;
}

export function CharacterControls({ busy, characterAsset, characterName, model, readySpeechModel, setCharacterName, setModel, upload, onChoose, onRun, onOpenSettings, step, onBack, onNext }: { busy: string | null; characterAsset: MediaAsset | null; characterName: string; model: SpeechModel; readySpeechModel: boolean; setCharacterName: (value: string) => void; setModel: (value: SpeechModel) => void; upload: (file: File | undefined) => void; onChoose: () => void; onRun: () => void; onOpenSettings: (focus: "environment" | "asr" | "tts") => void; step: number; onBack: () => void; onNext: () => void }) {
  const locale = useRecutLocale();
  const total = 2;
  return <div className="flex flex-col gap-6">
    {step === 0 && <ControlSection eyebrow={t(locale, "controls.input.eyebrow")} title={t(locale, "controls.character.title")}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t(locale, "controls.character.desc")}</p>
      <SourceButtons busy={busy !== null} onChoose={onChoose} onUpload={upload} selectedLabel={characterAsset ? t(locale, "source.character.change") : t(locale, "source.character.pick")} />
      {characterAsset && <SelectedSource asset={characterAsset} />}
      <div className="grid gap-2">
        <Label htmlFor="character-name" className="text-xs text-muted-foreground">{t(locale, "character.name.label")}</Label>
        <Input disabled={busy !== null} id="character-name" onChange={(event) => setCharacterName(event.target.value)} placeholder={t(locale, "character.name.placeholder")} value={characterName} />
      </div>
    </ControlSection>}
    {step === 1 && <ControlSection eyebrow={t(locale, "controls.model.eyebrow")} title={t(locale, "controls.character.promptModelTitle")}>
      <ModelSelect disabled={busy !== null} model={model} onChange={setModel} />
      {readySpeechModel ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Check className="size-3.5" />{t(locale, "downloaded")}</p> : <div className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><p className="text-amber-600">{t(locale, "controls.model.missing")}</p><Button disabled={busy !== null} onClick={() => onOpenSettings("asr")} type="button" variant="outline" size="sm" className="w-fit">{t(locale, "settings.open")}</Button></div>}
    </ControlSection>}
    <StepFooter busy={busy} finishDisabled={busy !== null || !characterAsset || !characterName.trim() || !readySpeechModel} finishLabel={busy === "character" ? <><LoaderCircle className="size-4 animate-spin" />{t(locale, "controls.character.title")}</> : <><Mic className="size-4" />{t(locale, "controls.character.title")}</>} onBack={onBack} onFinish={onRun} onNext={onNext} step={step} total={total} />
  </div>;
}
