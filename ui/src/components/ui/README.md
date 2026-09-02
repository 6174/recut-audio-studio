# components/ui/

> L2 | 父级: /apps/audio-studio/ui/src/README.md

成员清单
badge.tsx: 状态徽标组件，承载完成、失败与私有结果标签。
button.tsx: 统一按钮组件，提供工作流动作、筛选和图标按钮变体。
card.tsx: 统一面板容器，集中定义圆角、背景、边框、间距与标题内容结构。
input.tsx: 单行输入组件，供名称、文本和可编辑转写片段使用。
label.tsx: 表单标签组件，连接输入控件与可访问名称。
select.tsx: Radix 下拉选择组件，供模型、语言、引擎和预设选择使用。
separator.tsx: 内容分隔组件，保持面板内部层级。
tabs.tsx: 页签基础组件，提供可复用的切换语义。
textarea.tsx: 多行文本组件，供音色描述和配音文本使用。

架构边界

所有业务面板共享 `card.tsx` 的视觉基线；业务状态只通过调用方追加选中、错误或终端内容样式，不在各页面重复定义面板外壳。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
