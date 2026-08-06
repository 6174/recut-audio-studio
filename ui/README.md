# ui/

> L2 | 父级: /apps/audio-studio/README.md

成员清单
index.html: Vite 入口 HTML。
package.json: React/Vite/Tailwind/Radix/shadcn 依赖与构建脚本。
components.json: shadcn/ui 配置（radix-mira 风格、Tailwind v4、`@/` 别名）。
tsconfig.json: 严格 TS 与 `@/*` 路径别名。
vite.config.ts: 以相对资源地址交付给 Recut App Host 的构建配置，含 Tailwind v4 插件。
src/: 声音工坊工作台源码；构建产物 `dist/` 是 manifest 声明的运行时入口。

依赖关系

`ui/dist -> manifest.json`；构建产物是 `standaloneView` 的唯一入口，模型下载与推理由服务进程触发，不在 UI 打包流程中执行。

[PROTOCOL]: 变更时更新此头部，然后检查 README.md
