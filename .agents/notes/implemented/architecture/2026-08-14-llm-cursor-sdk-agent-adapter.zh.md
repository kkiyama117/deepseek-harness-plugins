# Agent Note：LLM 接缝的 Cursor SDK agent 适配器

Status: implemented

[English](2026-08-14-llm-cursor-sdk-agent-adapter.md) | 中文

## 问题

Harness LLM 接缝（`ctx.llm`）使用 provider 中立的流式词汇，其两个在售适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`——[孪生适配器设计](https://github.com/deepseek-ai/deepseek-harness/blob/main/.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md)）都把 provider 建模为*模型端点*：provider 返回文本、推理和工具调用，由 harness 循环执行。Cursor 不符合这种形态。Cursor 的产品是*agent 循环*——Cursor SDK（`@cursor/sdk`）在 `Run` 内部运行自己的工具、自己的会话和自己的模型选择。把 Cursor 翻译成 OpenAI 形态的端点（代理方案）会丢失 agent 循环，而这正是使用 Cursor 的全部意义；参考 Pi 扩展（`pi-cursor-sdk`）刻意在其 provider 的 `streamSimple` 内运行 SDK 的 agent 循环，保持 "Cursor remains Cursor"。

## 决策

在本仓库以树外 dsh bundle 发布 `@kkiyama117/dsh-llm-cursor`，作为第三个把一次 Cursor agent 运行当作一次 harness 模型调用的 `LlmAdapter`：

- **Cursor agent 循环在适配器内部保持完整。** 每次 `stream()` 调用创建（或恢复）一个 Cursor agent，把扁平化的 harness 对话作为一条提示词发送，并流式读取该运行。harness 只看到推理、文本和用量；agent 内部工具活动不透明，与子代理完全一致。harness 工具 schema 从不发送，SDK 的 `tool_call`/`tool_use` 事件刻意**不**重放为 harness 工具调用块——harness 会二次执行它们。
- **会话连续性依托接缝的 replayState。** 成功结束时存储 `{ kind: 'cursor', version: 1, agentId }`；下一次普通对话请求恢复该 agent（`Agent.resume`）并只发送最新用户消息。因此 Cursor agent 自身的对话可以跨 harness 回合和进程重启存续（本地 `JsonlLocalAgentStore` 持久化在 `stateRoot` 下）。辅助调用（`purpose: compaction`/`session-title`）始终在全新 agent 上运行，绝不会污染被恢复的对话。
- **适配器与其孪生一样只负责传输。** 连接事实通过 thunk 每次操作解析（settings 分层、credentials 解析），重试策略是注册时捕获的唯一事实，路由以 `cursor` 注册，并带有可配置 provider 目录条目和目录优先的模型发现——无凭据时以已配置目录作答，草稿或路由已存储的 key 提供凭据时以实时 Cursor SDK 目录（`Cursor.models.list()`）作答。
- **采样旋钮被拒绝而非丢弃。** `stop`、`temperature`、`maxTokens` 和 `reasoningEffort` 抛出 `UNSUPPORTED_OPTION`，因为 SDK `send` 没有线上等价物；agent 循环默认不发送这些字段，因此拒绝只对显式配置触发。

## 备选方案

- **OpenAI 兼容的 Cursor 代理**——为许多客户端提供通用 `/v1` 端点，但它把 Cursor 的 agent 行为翻译成 OpenAI 形态的请求，丢失 agent 循环；参考扩展正是为此拒绝它。
- **把 Cursor 工具调用重放进 harness 循环**——harness 会二次执行 agent 已执行过的工具，而模型永远看不到结果；会话日志会谎报实际发生的事。
- **每次调用都用全新 agent**——更简单，但每回合都要重发扁平化历史，并丢失 Cursor 的原生会话记忆，而那是该产品的价值所在。
- **放进 harness 主仓库**——harness 仓库刻意保持其适配器家族（孪生适配器设计）；由专有 SDK 支撑的第三个适配器属于树外、以 bundle 安装，使主仓库保持上游干净。

## 后果

harness 获得第三个适配器家族——一种*子代理式*模型后端，由 provider 拥有循环——而主仓库无需携带它：bundle 的 patch 层插入 `llm-cursor` 行，`dsh plugin --profile <name> add <本目录>` 即可安装。会话日志记录扁平化提示词和 agent 的推理/文本/用量——agent 内部工具活动无法从日志重建，这与子代理委托的诚实边界相同。适配器将 `@cursor/sdk@1.0.23` 固定为精确版本（SDK 随附平台相关的可选二进制；固定版本与参考扩展一致）。已知缺口记录在包 README：归属头无法通过 SDK 传输注入、harness 工具未桥接进 agent（Pi 的 MCP 桥模式是未来工作）、清空存储会响亮地破坏会话连续性而非静默重启。
