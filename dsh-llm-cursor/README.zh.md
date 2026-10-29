# @kkiyama117/dsh-llm-cursor

[English](README.md) | 中文

基于 [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk)（固定为 `1.0.23`，与参考 Pi 扩展构建和测试所用的版本一致）的 DeepSeek Harness LLM 接缝适配器：每次 harness 模型调用对应一次 Cursor agent 运行。Cursor agent 循环在 SDK 内部执行自己的工具，因此 harness 只看到推理、文本和用量——agent 结束时回合即结束。会话连续性依托接缝的 replayState：成功结束时保存 Cursor agent id，下一次普通对话请求以仅含最新用户消息的方式恢复该 agent，因此 Cursor agent 自身的对话可以跨 harness 回合和进程重启存续（本地存储持久化在 `stateRoot` 下）。

包根导出 Cordis 插件契约和 `CursorAdapter`；提示词扁平化、SDK 消息翻译和错误映射是独立的模块。

## 安装

在 harness 检出目录中：

```sh
pnpm dsh plugin --profile web add /data/softwares/deepseek-harness-plugins/dsh-llm-cursor
```

bundle 的 patch 层插入 `llm-cursor` 行，在 harness LLM 接缝上注册 `cursor` provider 路由。重启 harness，通过 credentials 服务（web Models 页面写入）或导出 `CURSOR_API_KEY` 存储 Cursor SDK API key，然后选择 `cursor/*` 模型。

## 配置

```yaml
- id: llm-cursor
  name: '@kkiyama117/dsh-llm-cursor'
  config:
    apiKeyEnv: CURSOR_API_KEY  # default; resolved per request via ctx.credentials, then the environment
    runtime: local            # optional; local (default) or cloud
    cwd: /path/to/workspace   # optional; local agents run their tools here (default: process.cwd())
    stateRoot: ~/.dsh/cursor  # optional; local agent store root (default: $DSH_HOME/cursor)
    mode: agent               # optional; agent (default) or plan
    models:                   # optional; advisory catalog, defaults to `default` and `composer-2.5`
      - id: default
        name: Default
        contextWindow: 128000
    defaultContextWindow: 128000 # optional positive-integer fallback; this is the default
    streamIdleTimeoutMs: 300000  # optional; positive finite Node timer delay; five-minute default
    retryPolicy:             # optional; omission uses bounded normal defaults
      mode: normal
      maxRetries: 3
    params:                  # optional; extra model parameters merged into every ModelSelection
      - id: thinking
        value: 'true'
```

插件注册单一 provider 路由 `cursor`。请求以 `provider: cursor` 选择它；其 `model` 原样作为 Cursor 模型 id 传递，因此更换 Cursor 模型无需生命周期期注册。省略 `models` 时广告 `default` 和 `composer-2.5`，各自使用路由的 `defaultContextWindow`；显式列表整体替换这些默认值，而 `models: []` 不广告任何模型。目录条目通过 `ctx.llm.listModels('cursor')` 暴露给 ACP 编辑器和 Web 选择器等客户端，但仅为建议性：未列出的模型 id 仍原样放行。

`runtime: cloud` 运行 Cursor Cloud agent 而非本地 SDK 循环；此时本地存储和 `cwd` 不再使用。`params` 条目合并进每个 `ModelSelection`（SDK 的模型参数词汇，例如 `thinking: true`）。推理档位通过 harness 的 reasoning-effort 接缝暴露：适配器将 SDK 目录中的 effort 词汇（Grok/Claude 模型的 `effort`、GLM/GPT 模型的 `reasoning`）作为推理档位提供，模型选择器可按模型选择档位。

`streamIdleTimeoutMs` 约束每次未完成的 provider 读取，不计算消费方在块之间的思考时间。每次 `stream()` 调用恰好执行一次 Cursor agent 运行；适配器将配置的策略注册为 provider 元数据，`dsh-llm-retry` 在持久 agent 步骤边界单独执行它。

## 动态配置（settings + credentials）

连接事实不在加载时冻结。`resolveAdapterOptions` 是从原始配置到已验证事实的唯一显式解析步骤，适配器通过 thunk **每次操作**重新读取：runtime、cwd、状态根、目录和空闲预算都在下一次请求生效，而进行中的流保持其开始时的事实。两个可选接缝为 thunk 供数：

- **`ctx.settings`** — 插件以同一 `Config` schema 注册 `llm-cursor` 命名空间，并以 `cordis.yml` 条目作为组合 `base`，因此用户设置文档中的 `llm-cursor:` 段无需重启即可覆盖任意字段。未挂载 settings 服务时仅由条目配置驱动适配器，行为不变。通过 schema 但违反 schema 之外约束（空状态根、重复目录 id）的实时设置快照保留最后的好事实并记录失败；条目配置本身仍会导致插件加载失败。
- **`ctx.credentials`** — API key 每次流调用解析，来自与连接事实*同一*已解析快照。配置只携带 `apiKeyEnv`，绝不携带字面 key：引用经 credential 接缝解析，未挂载接缝时经可信环境层解析。每个解析出的 key 使用前都做格式检查，因此无法放入 HTTP 头的值以 `LlmError('INVALID_CREDENTIAL')` 拒绝并指明失败入口——绝不包含 key 的任何部分。任何地方都没有 key 的请求以 `MISSING_CREDENTIAL` 失败并指明每个配置入口，而路由保持注册、目录保持可浏览。

注册时捕获的唯一事实是重试策略：其解析值变化时，插件原地重新注册路由（同一适配器实例，一个同步段），因此 `ctx.llm.providerRetryPolicy('cursor')` 始终报告当前策略。

插件还在可配置 provider 目录（`ctx.llm.listConfigurableProviders()`）中声明其路由：provider `cursor`、settings 命名空间 `llm-cursor`、空 settings 路径——整个段即 profile。

## 模型发现

插件提供 `ctx.llm.registerModelDiscovery('llm-cursor', …)`，回答"该 provider 能服务哪些模型？"，供配置界面编辑或起草路由时使用。命名 `cursor` 路由的草稿在可用凭据时从**实时 Cursor SDK 目录**作答（`Cursor.models.list()`，即 pi-cursor-sdk `/cursor-refresh-models` 的等价物）——草稿中键入的 key，否则为路由已存储的 key。回复是供界面采纳的候选，绝不写入存储目录。没有任何凭据时，草稿从已配置目录作答，不发网络请求。其他一切草稿——base URL、外来路由——以 `DISCOVERY_UNSUPPORTED` 拒绝，因为 Cursor 模型来自 Cursor SDK，而非本适配器可询问的端点。

## Provider/模型路由与重放

每次解析产生一个**不可变**连接事实快照，在操作的第一次 `await` 之前捕获。因此配置变更作用于下一次请求，绝不作用于进行中的请求。

成功结束会发出携带 Cursor agent id 的 `finish.replayState`（`{ kind: 'cursor', version: 1, agentId }`）。下一次请求时，适配器读取最新模型产出的 assistant 消息上的重放状态、校验之，并且——仅限普通对话请求——恢复该 agent（`Agent.resume`）并只发送最新用户消息，因为 agent 已持有对话。辅助调用（`purpose: compaction` 或 `session-title`）始终在全新 agent 上以扁平化历史运行，因此摘要或标题调用绝不会污染被恢复 agent 的对话。格式错误的重放状态在任何 SDK 交互之前以 `LlmError('INVALID_REPLAY_STATE')` 失败；被恢复的 agent 已不存在（存储被清空）时以 `INVALID_REQUEST` 响亮失败，而非静默重新开始。

## 词汇差异

- Cursor agent 循环在 SDK 内部执行自己的工具，因此 `tool_call` 消息和 assistant `tool_use` 块**不会**重放为 harness 工具调用块：harness 会二次执行它们。harness 只看到推理、文本和用量；agent 内部工具活动不透明，与子代理完全一致。
- 全新 agent 收到扁平化的 harness 对话作为一条提示词：系统提示词，随后每条消息渲染为 `User:`/`Assistant:` 文本，工具调用与结果作为转写。推理块是模型内部内容，绝不渲染。
- `GenerateOptions.stop`、`temperature` 和 `maxTokens` 以 `UNSUPPORTED_OPTION` 拒绝：Cursor SDK `send` 接受提示词、模型选择和模式，没有采样旋钮或停止序列的线上等价物。agent 循环默认不发送这些字段，因此拒绝只对显式配置触发。
- `reasoningEffort` 映射到模型的 effort 参数：适配器将 SDK 目录的 effort 词汇（Grok/Claude 模型的 `effort`、GLM/GPT 模型的 `reasoning`）作为 harness 推理档位暴露，模型选择器可按模型选择档位。所选档位成为模型参数（例如 `effort: high`），替换同 id 的已配置 `params` 条目；无词汇表的模型保持 SDK 默认变体。
- SDK 错误类映射为稳定 harness 码：`AuthenticationError` → `AUTH`，`RateLimitError` → `RATE_LIMIT`，`NetworkError` → `SERVER`，`AgentBusyError`/`UnknownAgentError`/`ConfigurationError` → `INVALID_REQUEST`，通用可重试 SDK 错误 → `SERVER`，其余 → `TRANSPORT`。失败的运行以携带运行自身错误码和消息的错误 finish 结束流。
- 调用方取消会取消 Cursor 运行并抛出 `ABORTED`；配置的流空闲预算会取消运行并抛出 `TIMEOUT`。

## 应用归属

每个 provider HTTP 请求都必须携带 dsh-llm `attributionHeaders()` 的共享归属头。`@cursor/sdk` 1.0.23 不暴露任何头钩子（`CursorRequestOptions` 只携带 API key），因此本适配器无法将 harness 归属头注入 SDK 传输；SDK 发送自己的 User-Agent。这是对适配器契约的已记录偏离，列入 Known Limitations。

## 依赖重量

`@cursor/sdk` 固定精确版本（而非范围），因为 SDK 随附平台相关的可选二进制；固定版本与参考 Pi 扩展构建和测试所用的版本一致。SDK 通过每次流调用时的动态 `import()` 加载，因此其依赖重量不进入插件启动。本地 runtime 使用 SDK 的 `JsonlLocalAgentStore`（`stateRoot` 下的 JSONL 文件），无需原生 `sqlite3` 模块。

## 模型体验

### Cursor agent 请求

#### 模型所见

Cursor agent 收到扁平化的 harness 对话作为一条用户消息（全新 agent 为系统提示词加历史，被恢复 agent 为最新用户消息）。本包除扁平化历史的 `System instructions:` / `User:` / `Assistant:` 框架外不添加任何提示词散文。

#### Token 影响

provider 分词决定精确输入。扁平化增加角色框架行；推理块被丢弃而非重发。被恢复 agent 只发送新用户消息，因此输入最小。

#### KV 缓存影响

Cursor agent 自身的对话就是缓存域：被恢复 agent 复用其存储上下文，全新 agent 从扁平化历史开始。更换 agent（存储被清空、新的 `stateRoot`）开启新域。

### Cursor agent 响应

#### 模型所见

SDK thinking 消息变为 harness 推理块，assistant 文本变为文本块，用量消息变为用量块。agent 循环内部的工具活动不对外呈现。

#### Token 影响

生成内容只在循环记录后才影响后续输入。SDK 的每回合用量在可用时上报；未上报用量的运行产出零用量。

#### KV 缓存影响

已记录响应内容通过被恢复 agent 自身的对话追加到下一次请求，不使其更早的可复用前缀失效。未记录的传输元数据和用量记账不影响缓存身份。

## 已知限制与待办工作

- **归属头不可注入** — `@cursor/sdk` 1.0.23 不暴露头钩子，因此强制的 harness 归属头无法到达 SDK 传输；SDK 发送自己的 User-Agent。未来的 SDK 头钩子或传输层 fork 可弥合此缺口。
- **Cursor 回合期间 harness 从不执行工具** — Cursor agent 循环在 SDK 内部运行自己的工具，harness 的工具 schema 不会发送。将 harness 工具桥接进 Cursor agent（Pi 扩展的 MCP 桥模式）暂缓。
- **被恢复 agent 的对话可能与 harness 历史分叉** — compaction 和 session-title 调用在全新 agent 上运行，但压缩后的 harness 历史不会重放进被恢复 agent；agent 保留自己（更长的）上下文。
- **清空存储会响亮地破坏会话连续性** — 被恢复 agent 已不存在时以 `INVALID_REQUEST` 失败，而非静默重新开始；没有回退到全新 agent 的机制。
- **推理档位词汇表是静态快照** — 选择器提供的推理档位来自内置表（镜像 SDK 目录：Grok/Claude 模型的 `effort`、GLM/GPT 模型的 `reasoning`），而非实时获取；表中没有的模型不暴露档位，保持 SDK 默认变体。
- **不支持 `GenerateOptions.stop`、`temperature` 和 `maxTokens`** — Cursor SDK 没有线上等价物；显式配置以 `UNSUPPORTED_OPTION` 失败。
- **Discovery 只提供、不存储** — 实时目录按需为 Models 页面获取，但没有任何东西把取回的列表写入 `settings.yaml`；采纳候选是配置界面的职责，建议性目录仍以设置文档为准。
- **Cloud 运行未经 harness 实测** — `runtime: cloud` 路径按 SDK 选项形状实现，但本包 e2e 套件没有真实 API 覆盖。
