# src/

> L2 | 父级: /apps/audio-studio/ui/README.md

成员清单
main.tsx: 工作台编排层；先锁住未就绪环境，再以三步工作流切换转写、声音角色、配音，管理持久化 Download Source 与会话级配音草稿，处理模型下载、转写、声音角色、配音合成、任务日志与显式入库；顶部入口卡片采用紧凑的图标、信息、箭头横向结构并按当前工作流显示选中态，减少首屏垂直占用；任务中心按状态筛选并提供可访问的停止按钮，详情面板只在结果真正入库后显示已保存。界面由 shadcn/ui（Card/Button/Input/Label/Textarea/Select/Badge/Separator）与 Tailwind CSS v4 语义角色构成，复用 Recut 平台设计令牌，不重复实现表单与选择组件。
recut-sdk.ts: Host MessageChannel 的 operation、平台素材选择与 Agent 通信边界；后台 operation 使用保留字段 `operation` 传递，业务字段可安全使用 `name`。
voice.tsx: 页签式声音选择器（预设/我的角色，场景分组 + 缓存徽标 + 受限试听）与「设计声音」弹框（audio.character.design）；预设清单经 audio.presets 拉取，名称和说明先按当前 locale 从 string 或 {zh,en} 对象归一化后再渲染。
types.ts: App operation 与素材库返回值的领域类型。
index.css: Tailwind CSS v4 与 Recut 平台一致的暗色优先颜色、排版和响应式布局基础层。
lib/utils.ts: shadcn/ui 组件的类名合并工具（cn）。
components/ui/: shadcn/ui 基础组件集合；card.tsx 统一所有工作区面板的圆角、背景、边框、间距和阴影基线（见 components/ui/README.md）。

依赖关系

`main.tsx` 只通过 `recut-sdk.ts` 调用 App operation 与宿主 `media.pick`；后台路由固定通过 `operation` 传递，角色的业务 `name` 不会覆盖它。平台在父页面展示带缩略图的完成态全局素材库，App 只接收稳定 `assetId` 并在自身工作台预览所选音频或视频。预设显示层必须把 `{zh,en}` 本地化对象折叠为字符串，React 不直接渲染外部 JSON 对象；语音模型与 Download Source 都使用 shadcn Select，不调用原生下拉菜单；Download Source 会随成功提交的下载持久化，自动模式先 Hugging Face 后 ModelScope；配音文本、角色和情绪保存到当前浏览会话，提交任务前再次同步，因此合成预览刷新、任务失败或取消都不会清空输入，方便基于原参数二次编辑；启动页只展示当前任务的 stdout/stderr 和终态错误，不暴露额外运行时设置；状态优先刷新，历史读取失败不能阻塞进入工作台；任务中心默认展示历史，准备环境、下载模型、转写、创建角色或合成配音时自动更新执行日志，并显示任务计时；入口卡片与弹窗负责发起工作流，左侧任务列表负责选择、筛选和停止，右侧详情负责日志、结果预览与显式入库，结果状态不得与素材库状态混淆；`audio.job` 从持久记录重放实时事件接入前或刷新期间的状态、stdout/stderr，`audio.resolve` 只在终态已被成功处理后清理该记录；`audio.transcribe` 完成后通过 `audio.transcript` 取得分段与 SRT，`audio.character.create` 完成后通过 `audio.character.complete` 取得角色参考音与提示词，`audio.synthesize` 完成后通过 `audio.synthesis.complete` 取得私有 `outputURL`；`audio.save` 是唯一可以把配音或角色参考音写入素材库的 UI 动作。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
