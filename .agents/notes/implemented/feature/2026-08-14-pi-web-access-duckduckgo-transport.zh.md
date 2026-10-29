# Agent Note：把 pi-web-access 的无密钥 DuckDuckGo 搜索搬进 web seam

状态：implemented

[English](2026-08-14-pi-web-access-duckduckgo-transport.md) | 中文

## 问题

harness 唯一挂载的搜索提供方 `web-search-deepseek` 需要账户有余额的 DeepSeek API key：余额耗尽时每次 `web_search` 都会失败（`HTTP 402 insufficient_quota`，以原始 `Error: Insufficient Balance` 呈现）。目标是不产生任何账单也能搜索。

用户的 pi 环境里有一个叫 `pi-web-access` 的 `pi-package`（`~/.pi/agent/npm/node_modules/pi-web-access`，v0.22.0，MIT），其搜索后端包含无密钥的 DuckDuckGo HTML 抓取器。需求是把 pi 插件搬进 DeepSeek Harness，从 pi-web-access 的搜索能力开始。

pi-web-access 的按提供方模块与运行时无关：每个模块用普通 `fetch` 加 `linkedom` 解析导出 `isXAvailable()` / `searchWithX(query, options)`，与 pi 的耦合（`pi-coding-agent` 的 `ExtensionAPI` 注册和配置文件密钥解析）只限于顶层 `index.ts` 和路由中枢。正是这种分离让忠实移植变得很小。

## 决策

本仓库在树外托管手工制作的 harness 插件，与 deepseek-harness 主体分离。第一个插件 `@kkiyama117/dsh-web-search` 把 pi-web-access 的 DuckDuckGo 后端移植为以 `pi-web-access` 为 id 注册的 `WebSearchProvider`。它以 dsh 组合包（bundle）形式提供：`dsh plugin --profile <name> add <包目录>` 把包安装进 profile 并激活其 `cordis.patch.yml` 层，该层插入提供方行，并把基础组合包的 `web` 行覆盖为 `searchProvider: pi-web-access`。随发行版内置的基础组合包仍以 `deepseek-official` 为默认；DeepSeek 搜索仍可通过配置选用，供有余额的账户使用。

移植适配，每一条都是对上流模块的有意偏离：

- **错误分类**：上流抛普通 `Error`；移植版抛带 seam 错误码（`WEB_PROVIDER_ERROR`、`WEB_ABORTED`）的 `WebError`，让工具消费方、重试路由和 GUI 展示与其他提供方行为一致。
- **重定向策略**：请求不携带凭据（仓库的凭据重定向规则不适用），但仍设置 `redirect: 'error'` 以保持提供方卫生统一，并用真实 HTTP 回归测试证明 `Location` 目标从未被接触。
- **取消**：上流的 `AbortSignal.timeout(30s)` 被去掉；调用方的 `searchTimeoutMs` 负责时间预算，与兄弟提供方一致。
- **无活动监控**：上流的内存 `activityMonitor` 日志被去掉。
- **答案文本**：上流拼接的 `answer`（snippet 加 `Source: title (url)` 行）不映射为 `content`；seam 的 `formatSearchOutput` 已经用 snippet 渲染来源，映射会重复模型可见文本。
- **署名**：移植版保留 MIT 署名头与上流 `User-Agent` 字符串；`linkedom` 成为包依赖（用受维护的依赖，而非手写 HTML 解析）。

`PiSearchResult`/`PiSearchResponse` 类型保留上流的后端中立表面，使带密钥后端（Tavily、Brave、Exa、Perplexity、Kagi、SearXNG）成为机械的后续项——每个仍需要 dsh 凭据解析与重定向策略核查。

## 备选方案

- **直接桥接已安装的 npm 包。** 否决：pi-web-access 的搜索路由导入 `pi-coding-agent` 的 `ExtensionContext`，并从自己的配置文件解析密钥，绕过 dsh 凭据 seam；其带密钥提供方携带 `Authorization` 头并默认跟随重定向，不修改上流就违反仓库的凭据重定向策略；其 peer 依赖（`pi-coding-agent`、`pi-tui`）会把 pi 运行时拖进 harness。
- **通用 pi 扩展桥**（通过垫片 pi 扩展 API 加载任意 `npm:pi-*` 包）。推迟为独立的架构项目：正因为运行时耦合被隔离，逐插件移植才很小；而垫片的兼容性风险在当前只有一个插件的需求下不成立。
- **把插件留在 deepseek-harness monorepo 内。** 否决：手工插件应放在独立仓库，让主体保持上游洁净；monorepo 门禁（逐文件覆盖率、README/翻译检查、Agent Note）不适用于树外，且该包从 checkout 加载构建好的 `lib/`。
- **不用 `linkedom` 手写 DuckDuckGo 解析。** 否决：仓库偏好受维护的依赖而非自持解析代码，移植版保留 pi 经过测试的解析（广告排除、`uddg` 解码、域名过滤），而不是重新推导。

## 后果

`web_search` 对每个叠加了本组合包的 profile 零 key、零账单可用；余额耗尽的 DeepSeek 失败只保留给主动切回的部署。移植版是 fork 而非依赖：上流 pi-web-access 的变更不会自动流入。DuckDuckGo HTML 抓取天然脆弱——标记变更或异常页会降级为明确的「无结果可解析」错误，绝不会是静默的空结果。harness peer（`@deepseek-ai/dsh-web`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-invariants`）的运行时解析依赖包自身的 `node_modules`（开发时链接到 harness checkout）或 profile 的 pnpm 安装，因此全新克隆需要先在此执行 `pnpm install` 才能被 harness 启动。

## 测试

28 个单元测试，逐文件 100% 覆盖率：结果解析（广告、`uddg` 解码、域名过滤、上限）、错误与中止映射、插件注册/HMR 销毁，以及覆盖 301/302/303/307/308 的真实 HTTP 重定向规范，证明 `Location` 目标从未被接触。
