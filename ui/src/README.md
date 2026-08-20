# src/

> L2 | 父级: /apps/audio-studio/ui/README.md

成员清单
main.tsx: 工作台编排层；先锁住未就绪环境，再以带编号和输入/输出说明的三步工作流导航切换转写、声音角色、配音，管理持久化 Download Source（Whisper/Qwen/CosyVoice 共用）、会话级配音草稿（文本、角色、情绪在合成、失败、取消或工作台重挂载后保持）、模型下载、转写文稿编辑器（分段文本可改、SRT 实时重建与复制/下载）、声音角色创建/试听/删除/参考音入库、角色配音合成/试听/入库，以及按当前工作流展示的紧凑历史摘要卡；历史卡点击后在共享详情弹窗内复用工作区预览、播放、下载与保存操作。任务状态与日志同时订阅实时事件并从 App SQLite 恢复，运行任务提供停止按钮，连接迟到、刷新或失效的历史 job 记录都不会永久显示为运行中。界面由 shadcn/ui（Card/Button/Input/Label/Textarea/Select/Badge/Separator）与 Tailwind CSS v4 语义角色构成，复用 Recut 平台设计令牌，不重复实现表单与选择组件。
recut-sdk.ts: Host MessageChannel 的 operation、平台素材选择与 Agent 通信边界；后台 operation 使用保留字段 `operation` 传递，业务字段可安全使用 `name`。
types.ts: App operation 与素材库返回值的领域类型。
index.css: Tailwind CSS v4 与 Recut 平台一致的暗色优先颜色、排版和响应式布局基础层。
lib/utils.ts: shadcn/ui 组件的类名合并工具（cn）。
components/ui/: 由 shadcn CLI 生成的标准组件，不自造轮子。

依赖关系

`main.tsx` 只通过 `recut-sdk.ts` 调用 App operation 与宿主 `media.pick`；后台路由固定通过 `operation` 传递，角色的业务 `name` 不会覆盖它。平台在父页面展示带缩略图的完成态全局素材库，App 只接收稳定 `assetId` 并在自身工作台预览所选音频或视频。语音模型与 Download Source 都使用 shadcn Select，不调用原生下拉菜单；Download Source 会随成功提交的下载持久化，自动模式先 Hugging Face 后 ModelScope；配音文本、角色和情绪保存到当前浏览会话，提交任务前再次同步，因此合成预览刷新、任务失败或取消都不会清空输入，方便基于原参数二次编辑；启动页只展示当前任务的 stdout/stderr 和终态错误，不暴露额外运行时设置；状态优先刷新，历史读取失败不能阻塞进入工作台；底部默认展示历史，准备环境、下载模型、转写、创建角色或合成配音时自动切换到执行日志，并显示任务计时；用户切换到底部任一标签后，运行中的任务同步只更新数据，不改变当前视图；历史只渲染不可直接操作的摘要卡，点击后在弹窗中复用对应的转写、角色或配音预览组件，以便播放、编辑、下载或保存；`audio.job` 从持久记录重放实时事件接入前或刷新期间的状态、stdout/stderr，`audio.resolve` 只在终态已被成功处理后清理该记录；`audio.transcribe` 完成后通过 `audio.transcript` 取得分段与 SRT，`audio.character.create` 完成后通过 `audio.character.complete` 取得角色参考音与提示词，`audio.synthesize` 完成后通过 `audio.synthesis.complete` 取得私有 `outputURL`；`audio.save` 是唯一可以把配音或角色参考音写入素材库的 UI 动作。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
