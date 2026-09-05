/**
 * [INPUT]: 依赖 React（effect/派生值）、recut-sdk（useRecutLocale + events 订阅）、zustand store（./state/store）、业务动作（./state/actions）、lib/options（readSynthesisDraft）、lib/format（isTerminal/isValidActiveJob）与 components/ 下的 UI 组件
 * [OUTPUT]: App 编排层：订阅全局 store 并保留全部同步 effect（locale、草稿持久化、预设拉取、status 轮询与事件接入、任务/日志轮询、云端配音轮询、job 终态收尾），派生就绪状态与入口卡徽标后渲染 LauncherBar / TaskCenter / TaskDetail / 各模态框；所有业务动作（转写/克隆/设计/配音/安装/入库/停止）来自 state/actions，不再持有业务状态
 * [POS]: audio-studio UI 编排层；入口卡片负责启动工作流并显示该功能的排队/进行中标记，左侧任务中心负责选择与筛选，右侧详情负责日志和结果；模型下载与环境安装动作集中在设置面板（按行禁用），步骤内只留就绪引导；仅在环境和选定模型就绪后开放推理；UI 用户可见文案经 i18n.ts 随 locale 切换
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
import { createRoot } from "react-dom/client";
import { useEffect, useMemo } from "react";
import { AudioWaveform, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { recut, useRecutLocale } from "./recut-sdk";
import type { ShellJob, ShellJobLog } from "./types";
import { t, tF } from "./i18n";
import { readSynthesisDraft } from "./lib/options";
import { isTerminal, isValidActiveJob } from "./lib/format";
import { useAppStore } from "./state/store";
import { appendJobLog, askAgent, cancelTaskById, changeDownloadSource, chooseCharacterSource, chooseSource, createCharacter, designCharacter, draftFromStore, featureBusy, featureState, finishJob, installCosyVoice, installSpeechModel, installVoxCpm, loadAssets, loadTasks, markJobCompleted, preparePreset, prepareTarget, refresh, removeCharacter, restoreJob, saveCharacter, saveSynthesis, saveTranscript, selectTask, synthesizeVoice, syncJob, transcribeSource, updateSegmentText, upload } from "./state/actions";
import { DialogCard } from "./components/workflow";
import { CharacterControls, TranscribeControls } from "./components/step-controls";
import { Setup } from "./components/setup";
import { LauncherBar } from "./components/launcher";
import { CharList, CharacterEntries } from "./components/characters";
import { CharacterPreview } from "./components/results";
import { TaskCenter, TaskDetail } from "./components/tasks";
import { SettingsDialog } from "./components/settings";
import { DesignVoicePanel, DubbingControls, DubbingSelection } from "./voice";
import "./index.css";

function App() {
  const hookLocale = useRecutLocale();
  const locale = useAppStore((s) => s.locale);
  const status = useAppStore((s) => s.status);
  const characters = useAppStore((s) => s.characters);
  const charactersLoading = useAppStore((s) => s.charactersLoading);
  const tab = useAppStore((s) => s.tab);
  const model = useAppStore((s) => s.model);
  const language = useAppStore((s) => s.language);
  const busy = useAppStore((s) => s.busy);
  const message = useAppStore((s) => s.message);
  const logs = useAppStore((s) => s.logs);
  const elapsedSeconds = useAppStore((s) => s.elapsedSeconds);
  const failure = useAppStore((s) => s.failure);
  const activeJob = useAppStore((s) => s.activeJob);
  const tasks = useAppStore((s) => s.tasks);
  const selectedTask = useAppStore((s) => s.selectedTask);
  const taskLogs = useAppStore((s) => s.taskLogs);
  const taskFilter = useAppStore((s) => s.taskFilter);
  const taskResult = useAppStore((s) => s.taskResult);
  const activeTasks = useAppStore((s) => s.activeTasks);
  const launcherOpen = useAppStore((s) => s.launcherOpen);
  const workflowStep = useAppStore((s) => s.workflowStep);
  const charactersView = useAppStore((s) => s.charactersView);
  const viewCharacter = useAppStore((s) => s.viewCharacter);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const settingsFocus = useAppStore((s) => s.settingsFocus);
  const presets = useAppStore((s) => s.presets);
  const presetsError = useAppStore((s) => s.presetsError);
  const preparingPresetId = useAppStore((s) => s.preparingPresetId);
  const playingPresetId = useAppStore((s) => s.playingPresetId);
  const cloudBusy = useAppStore((s) => s.cloudBusy);
  const cloudResult = useAppStore((s) => s.cloudResult);
  const cloudJob = useAppStore((s) => s.cloudJob);
  const assets = useAppStore((s) => s.assets);
  const downloadSource = useAppStore((s) => s.downloadSource);
  const assetId = useAppStore((s) => s.assetId);
  const selectedAsset = useAppStore((s) => s.selectedAsset);
  const engine = useAppStore((s) => s.engine);
  const voxcpmVersion = useAppStore((s) => s.voxcpmVersion);
  const style = useAppStore((s) => s.style);
  const synthesisText = useAppStore((s) => s.synthesisText);
  const synthesisCharacterId = useAppStore((s) => s.synthesisCharacterId);
  const synthesisPresetId = useAppStore((s) => s.synthesisPresetId);
  const synthesisCloud = useAppStore((s) => s.synthesisCloud);
  const characterName = useAppStore((s) => s.characterName);
  const characterAsset = useAppStore((s) => s.characterAsset);

  // 派生：素材、就绪状态与入口卡徽标。
  const compatibleAssets = useMemo(() => assets.filter((asset) => asset.kind === "audio" || asset.kind === "video"), [assets]);
  const sourceAsset = selectedAsset?.id === assetId ? selectedAsset : compatibleAssets.find((asset) => asset.id === assetId) ?? null;
  const readySpeechModel = Boolean(status?.asr?.installed?.includes(model));
  const ttsReady = Boolean(status?.tts?.ready);
  const voxcpmEngine = status?.tts?.engines?.voxcpm ?? null;
  const voxcpmModel = voxcpmEngine?.models[voxcpmVersion] ?? null;
  const effectiveEngine = engine === "cosyvoice2" ? "cosyvoice2" : voxcpmVersion;
  const engineReady = engine === "cosyvoice2" ? ttsReady : Boolean(voxcpmModel?.ready);
  const engineNeedsCharacter = engine === "voxcpm" && voxcpmVersion !== "voxcpm2";
  // VoxCPM2 完整就绪（运行时 + 权重）；设计声音入口的徽标还需叠加 ASR 回读模型就绪。
  const voxcpm2Ready = Boolean(voxcpmEngine?.models["voxcpm2"]?.ready);
  const designReady = voxcpm2Ready && readySpeechModel;
  // 入口卡按功能归属的徽标状态（RFC task-queue）：running→进行中、queued→排队中；本地操作 busy 只影响发起它的那个功能。
  const launcherStates = {
    transcribe: featureState(activeTasks, ["transcribe"]) ?? (busy && ["transcribe", "upload", "save", "agent"].includes(busy) ? "running" : null),
    characters: featureState(activeTasks, ["character", "design"]) ?? (busy && ["character", "design", "upload", "agent"].includes(busy) ? "running" : null),
    synthesize: featureState(activeTasks, ["synthesize"]) ?? (busy && ["synthesize", "save", "agent"].includes(busy) ? "running" : null),
  };

  // ---- effects：同步订阅（store 状态 + 平台事件），动作逻辑在 state/actions ----
  useEffect(() => { useAppStore.setState({ locale: hookLocale }); document.documentElement.lang = hookLocale === "zh" ? "zh-CN" : "en"; }, [hookLocale]);
  // 会话级配音草稿：挂载时恢复，表单变化时持久化。
  useEffect(() => {
    const draft = readSynthesisDraft();
    useAppStore.setState({ synthesisText: draft.text, synthesisCharacterId: draft.characterId, synthesisPresetId: draft.presetId, synthesisCloud: draft.cloud, style: draft.style, engine: draft.engine, voxcpmVersion: draft.voxcpmVersion });
  }, []);
  useEffect(() => { draftFromStore(); }, [engine, style, synthesisCharacterId, synthesisCloud, synthesisPresetId, synthesisText, voxcpmVersion]);
  // 预设清单：进入工作台后拉取一次 audio.presets（只读 op）；失败仅在预设页签内提示，不阻塞工作台。
  useEffect(() => {
    if (!status?.ready || presets.length) return;
    void (async () => {
      try {
        const result = await recut.background.call("audio.presets", {}) as { presets?: typeof presets };
        useAppStore.setState({ presets: Array.isArray(result?.presets) ? result.presets : [], presetsError: "" });
      } catch (error) { useAppStore.getState().setPresetsError(error instanceof Error ? error.message : t(hookLocale, "preset.loadFailed")); }
    })();
  }, [status?.ready, presets.length, hookLocale]);
  useEffect(() => { const onReady = () => void refresh(); window.addEventListener("recut-sdk-ready", onReady); void refresh(); return () => window.removeEventListener("recut-sdk-ready", onReady); }, []);
  useEffect(() => { loadAssets().catch((error) => useAppStore.getState().setMessage(error.message)); }, []);
  useEffect(() => { if (isValidActiveJob(status?.activeJob)) restoreJob(status.activeJob); }, [status?.activeJob]);
  useEffect(() => {
    if (!activeJob) return;
    const updateElapsed = () => useAppStore.getState().setElapsedSeconds(Math.floor((Date.now() - activeJob.startedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [activeJob]);
  useEffect(() => {
    if (!activeJob || isTerminal(activeJob.status)) return;
    const timer = window.setInterval(() => { void syncJob().catch((error) => useAppStore.getState().setMessage(error instanceof Error ? error.message : t(locale, "msg.syncJobFailed"))); }, 1000);
    return () => window.clearInterval(timer);
  }, [activeJob, locale]);
  // 存在在途任务（含排队）时 1.5s 轮询 status：驱动后端队列推进 + 功能级状态 + 终态通告。
  useEffect(() => {
    if (activeTasks.length === 0) return;
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [activeTasks.length]);
  useEffect(() => recut.events.subscribe((raw) => {
    const event = raw as { type?: string; log?: ShellJobLog; job?: ShellJob };
    if (event.type === "shell.job.log" && event.log) appendJobLog(event.log);
    if (event.type !== "shell.job.completed" || event.job?.id !== activeJob?.id) return;
    markJobCompleted(event.job);
  }), [activeJob]);
  // 任务从「进行中」落到「已完成」时，自动加载其执行结果（不再需要手动重新点击）。
  useEffect(() => {
    if (selectedTask && selectedTask.state === "completed") void selectTask(selectedTask);
  }, [selectedTask?.id, selectedTask?.state]);
  useEffect(() => { void loadTasks(taskFilter); }, [taskFilter]);
  useEffect(() => {
    if (!selectedTask || isTerminal(selectedTask.state as ShellJob["status"])) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const result = await recut.background.call("audio.task.logs", { id: selectedTask.id, limit: 300 }) as { logs: typeof taskLogs };
          useAppStore.getState().setTaskLogs(result.logs);
          await loadTasks(taskFilter);
        } catch { /* 轮询失败忽略，等待下次间隔 */ }
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [selectedTask, taskFilter]);
  useEffect(() => { if (activeJob && isTerminal(activeJob.status)) void finishJob(activeJob); }, [activeJob]);
  // 云端配音任务轮询：completed 后直接以素材库 asset 播放（产物已全局入库）。
  useEffect(() => {
    if (!cloudJob) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/v1/media/jobs/${cloudJob.id}`);
          const jobText = await response.text();
          let job: { status?: string; assetIds?: string[]; error?: string };
          try { job = JSON.parse(jobText); } catch { return; }
          if (cancelled) return;
          if (job.status === "completed" && job.assetIds?.[0]) {
            const outputAssetId = job.assetIds[0];
            useAppStore.getState().setCloudResult({ url: `/v1/media/assets/${outputAssetId}/content`, name: cloudJob.name });
            useAppStore.getState().setMessage(t(locale, "dubbing.cloud.done"));
            useAppStore.setState({ cloudBusy: false, cloudJob: null });
          } else if (job.status === "failed") {
            const error = job.error || t(locale, "msg.synthesisFailed");
            useAppStore.getState().setFailure(tF(locale, "dubbing.cloud.failed", { error }));
            useAppStore.getState().setMessage(tF(locale, "dubbing.cloud.failed", { error }));
            useAppStore.setState({ cloudBusy: false, cloudJob: null });
          }
        } catch { /* 轮询失败忽略，等待下次间隔 */ }
      })();
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [cloudJob, locale]);

  if (!status?.ready) return <Setup autoPrepare={status !== null} busy={busy} elapsedSeconds={elapsedSeconds} failure={status?.setupError || failure || (!status?.pending ? status?.error || "" : "")} failureLogs={status?.setupLogs ?? []} logs={logs} message={message} pythonVersion={status?.pythonVersion} onPrepare={() => void prepareTarget("all")} onAskAgent={() => void askAgent()} />;

  const nav = { step: workflowStep, onBack: () => useAppStore.getState().setWorkflowStep((current) => current - 1), onNext: () => useAppStore.getState().setWorkflowStep((current) => current + 1) };
  const openSettingsFor = (focus: "environment" | "asr" | "tts") => useAppStore.setState({ settingsFocus: focus, settingsOpen: true });
  // 克隆流程不再放进主 controls：它只服务于角色二级模态框。
  const characterCloneControls = <div className="flex flex-col"><CharacterControls {...nav} busy={featureBusy(activeTasks, ["character"], ["character", "upload", "save", "agent"])} characterAsset={characterAsset} characterName={characterName} model={model} readySpeechModel={readySpeechModel} setCharacterName={(value) => useAppStore.getState().setCharacterName(value)} setModel={(value) => useAppStore.getState().setModel(value)} upload={(file) => void upload(file, "character")} onChoose={() => void chooseCharacterSource()} onRun={() => void createCharacter()} onOpenSettings={openSettingsFor} /></div>;
  const controls = <div className="flex flex-col gap-6">
    {tab === "transcribe" && <TranscribeControls {...nav} busy={featureBusy(activeTasks, ["transcribe"], ["transcribe", "upload", "save", "agent"])} language={language} model={model} readySpeechModel={readySpeechModel} setLanguage={(value) => useAppStore.getState().setLanguage(value)} setModel={(value) => useAppStore.getState().setModel(value)} sourceAsset={sourceAsset} upload={(file) => void upload(file, "source")} onChoose={() => void chooseSource(["audio", "video"])} onRun={() => void transcribeSource()} onOpenSettings={openSettingsFor} />}
    {tab === "synthesize" && status && <DubbingControls busy={featureBusy(activeTasks, ["synthesize"], ["synthesize", "save", "agent"])} characters={characters} charactersLoading={charactersLoading} cloudBusy={cloudBusy} cloudResult={cloudResult} engine={effectiveEngine} engineNeedsCharacter={engineNeedsCharacter} engineReady={engineReady} playingPresetId={playingPresetId} preparingPresetId={preparingPresetId} presets={presets} presetsError={presetsError} selection={{ characterId: synthesisCharacterId, presetId: synthesisPresetId, cloud: synthesisCloud }} status={status} style={style} text={synthesisText} voxcpmEngine={voxcpmEngine} onEngineChange={(value) => { if (value === "cosyvoice2") useAppStore.setState({ engine: "cosyvoice2" }); else useAppStore.setState({ engine: "voxcpm", voxcpmVersion: value as typeof voxcpmVersion }); }} onOpenSettings={openSettingsFor} onSubmit={() => void synthesizeVoice()} onPreviewPreset={(presetId) => void preparePreset(presetId, true)} onSelect={(selection: DubbingSelection) => useAppStore.setState({ synthesisCharacterId: selection.characterId, synthesisPresetId: selection.presetId, synthesisCloud: selection.cloud })} onStyleChange={(value) => useAppStore.getState().setStyle(value)} onTextChange={(value) => useAppStore.getState().setSynthesisText(value)} step={workflowStep} onBack={nav.onBack} onNext={nav.onNext} />}
  </div>;

  return <div className="mx-auto flex h-dvh w-full max-w-[1440px] flex-col overflow-hidden p-4 sm:p-6">
    <header className="flex shrink-0 items-center justify-between gap-4 px-1 py-1 sm:py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[0_8px_24px_rgba(34,197,94,0.16)]"><AudioWaveform className="size-5" /></span>
        <div className="min-w-0">
          <h1 className="text-base font-bold tracking-tight">{t(locale, "app.title")} <span className="font-normal text-muted-foreground">v1.0</span></h1>
          <p className="max-w-2xl truncate text-xs text-muted-foreground">{t(locale, "app.subtitle")}</p>
        </div>
      </div>
      <Button aria-label={t(locale, "settings.button")} disabled={busy === "agent"} onClick={() => openSettingsFor("environment")} size="icon" type="button" variant="outline"><Settings className="size-4" /></Button>
    </header>
    <LauncherBar active={tab} onLaunch={(next) => { useAppStore.setState({ tab: next, launcherOpen: next, workflowStep: 0, ...(next === "characters" ? { charactersView: "entries" as const, viewCharacter: null } : {}) }); }} states={launcherStates} />
    <main className="mt-4 grid min-h-0 flex-1 items-stretch gap-4 min-[900px]:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
      <TaskCenter tasks={tasks} filter={taskFilter} selectedTask={selectedTask} onCancelTask={(id) => void cancelTaskById(id)} onFilter={(filter) => useAppStore.getState().setTaskFilter(filter)} onSelect={(task) => void selectTask(task)} />
      <TaskDetail busy={busy === "save" || busy === "agent" ? busy : null} logs={taskLogs} selectedTask={selectedTask} result={taskResult} onEditSegment={updateSegmentText} onSaveCharacter={(character) => void saveCharacter(character)} onSaveSynthesis={(synthesis) => void saveSynthesis(synthesis)} onSaveTranscript={(transcript) => void saveTranscript(transcript)} />
    </main>
    {launcherOpen === "characters" ? (
      <DialogCard headerAction={<Badge className="shrink-0 text-[11px]" variant="outline">{tF(locale, "characters.all", { count: characters.length })}</Badge>} onClose={() => useAppStore.setState({ launcherOpen: null, charactersView: "entries", viewCharacter: null })} title={t(locale, "nav.characters.label")}>
        <CharacterEntries characters={characters} designReady={designReady} onPick={(entry) => useAppStore.setState({ charactersView: entry, viewCharacter: null })} />
      </DialogCard>
    ) : launcherOpen ? (
      <DialogCard title={t(locale, launcherOpen === "transcribe" ? "nav.transcribe.label" : "nav.synthesize.label")} onClose={() => useAppStore.getState().setLauncherOpen(null)}>{controls}</DialogCard>
    ) : null}
    {launcherOpen === "characters" && charactersView !== "entries" ? (
      <DialogCard level="top" onBack={() => useAppStore.setState({ charactersView: "entries", viewCharacter: null })} title={t(locale, charactersView === "clone" ? "characters.entry.clone.title" : charactersView === "design" ? "characters.entry.design.title" : "characters.entry.manage.title")} onClose={() => useAppStore.setState({ launcherOpen: null, charactersView: "entries", viewCharacter: null })}>
        {charactersView === "clone" ? characterCloneControls
          : charactersView === "design" ? <DesignVoicePanel asrReady={readySpeechModel} busy={featureBusy(activeTasks, ["design"], ["design", "agent"])} onClose={() => useAppStore.setState({ launcherOpen: null, charactersView: "entries", viewCharacter: null })} onOpenSettings={() => openSettingsFor("tts")} onSubmit={(input) => void designCharacter(input)} presets={presets} voxcpm2Ready={voxcpm2Ready} />
          : viewCharacter ? <div className="grid gap-3"><Button className="w-fit" onClick={() => useAppStore.getState().setViewCharacter(null)} size="sm" type="button" variant="ghost">{t(locale, "characters.backEntries")}</Button><CharacterPreview busy={featureBusy(activeTasks, ["character"], ["save"])} character={viewCharacter} onRemove={() => void removeCharacter(viewCharacter)} onSave={() => void saveCharacter(viewCharacter)} /></div>
          : <CharList characters={characters} onOpen={(character) => useAppStore.getState().setViewCharacter(character)} />}
      </DialogCard>
    ) : null}
    {settingsOpen ? (
      <DialogCard level="top" title={t(locale, "settings.title")} onClose={() => useAppStore.getState().setSettingsOpen(false)}>
        <SettingsDialog activeTasks={activeTasks} downloadSource={downloadSource} focus={settingsFocus} onInstallAsr={(selected) => void installSpeechModel(selected)} onInstallCosyVoice={() => void installCosyVoice()} onInstallVoxCpm={(version) => void installVoxCpm(version)} onPrepareTarget={(target) => void prepareTarget(target)} onSetDownloadSource={(source) => void changeDownloadSource(source)} presets={presets} status={status} />
      </DialogCard>
    ) : null}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
