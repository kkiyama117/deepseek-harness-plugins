# @kkiyama117/dsh-web-search

[English](README.md) | 中文

面向 DeepSeek Harness [web 能力 seam](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/architecture.md)（`ctx.web`）的无密钥 `WebSearchProvider`，移植自 [pi-web-access](https://github.com/nicobailon/pi-web-access)（MIT）。它在服务端抓取 DuckDuckGo 的 HTML 结果端点，并把结果行解析为 seam 规范化的 `WebSearchResult`。不需要 API key，不产生账单：该提供方无条件可用。

这是**实现**插件：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（那是 [dsh-tool-web](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/web/tool-web/README.md) 的职责）。与 `@deepseek-ai/dsh-web-search-deepseek` 一样，它是函数/命名空间插件（`inject: ['web']`）来注册后端，而不是默认导出的服务。

## 安装

该包以 dsh **组合包**（bundle）形式提供：其 `cordis.patch.yml` 层挂载提供方行，并把基础组合包的 `web` 行覆盖为 `searchProvider: pi-web-access`。在 harness checkout 中安装到 profile：

```sh
pnpm dsh plugin --profile web add /path/to/deepseek-harness-plugins/plugins/dsh-web-search
```

该层在基础组合包之后应用，因此无密钥默认生效；`searchProvider: deepseek-official`（配置或 `$DSH_WEB_SEARCH_PROVIDER`）仍可在账户有余额时选择 DeepSeek 搜索。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://html.duckduckgo.com/html/` | DuckDuckGo HTML 端点。无法解析的值会使提供方不可用。 |
| `numResults` | （未设置） | 请求未携带 `maxResults` 时的默认结果数。必须是正整数；后端会钳制到 1..20。 |

```yaml
- id: web-search-pi-web-access
  name: '@kkiyama117/dsh-web-search'
```

## 映射

DuckDuckGo 返回的是结果页而非 API 信封，因此每个 `.result` 行（广告行除外）映射为一个 `WebSearchSource`：`url` ← 解码后的 `uddg` 重定向目标（非 http(s) 目标会被丢弃）、`title` ← `result__a` 锚点文本、`snippet` ← `result__snippet` 文本（为空时省略）。请求的 `maxResults` 优先于配置的 `numResults` 默认值；最终上限由 seam 强制。没有任何可解析结果行的页面（异常/拦截页）是错误，而不是空结果。

pi-web-access 拼接的答案文本不会映射为 `content`：seam 自己的格式化已用 snippet 渲染来源，映射会重复该文本。

提供方失败（HTTP 错误、网络失败、无法解析的响应）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止的请求以 `WEB_ABORTED` 呈现。HTTP 重定向在接触 `Location` 目标前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。提供方不持有自己的超时：调用方的 `searchTimeoutMs` 负责时间预算。

## 模型体验

没有辅助模型请求：与 DeepSeek 搜索不同，该提供方从不调用模型——每次搜索只向 DuckDuckGo 发一次普通 HTTP GET，因此除结果文本外不产生提供方 token。

间接地，通过 `dsh-tool-web`，会话模型会看到受 `maxResults` 限制的 URL、标题与 snippet，或在消费方错误包装下的提供方确切失败消息：`DuckDuckGo search aborted`、`DuckDuckGo search request failed: <error>`、`DuckDuckGo search error (HTTP <status>): <detail>`、`DuckDuckGo returned no parseable results (invalid response)` 与 `DuckDuckGo returned an unprocessable response body: <error>`。

#### KV Cache 影响

无。提供方不持有会话上下文，也不发起模型请求。

## 已知限制与待办

- **HTML 抓取脆弱** —— DuckDuckGo 可能改变结果标记，或在负载下返回异常页；变更的页面会降级为无结果可解析错误，而不是静默的空结果。
- **目前只移植了 DuckDuckGo 后端** —— pi-web-access 的带密钥后端（Tavily、Brave、Exa、Perplexity、Kagi、SearXNG 等）仍在上游；通过共享结果类型移植其中一个很机械，但每个都需要 dsh 凭据解析与重定向策略核查。
- **树外加载** —— dsh 从本 checkout 加载构建好的 `lib/`，因此源码变更需要在此执行 `pnpm build` 并重启 harness；热重载不监听本仓库。
- **没有 `content` 答案** —— pi-web-access 的拼接答案被有意丢弃（见「映射」）；带真实生成答案的后端（Perplexity）可以重新引入它。
