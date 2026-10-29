# Agent Note: 持久化最终回答翻译以插件对形式交付

Status: implemented

[English](2026-08-14-output-translate-plugin-pair.md) | 中文

## 问题

Web GUI 用户希望代理的最终回答以日语显示，而模型的思考保持原样。用户看到的输出是会话日志中已落定的 `assistant/message` 渲染结果，而日志同时是 UI 与模型派生历史的唯一事实来源——因此翻译功能不能改写消息，不能泄漏进 `deriveMessages()`，并且必须能在回放与恢复后保持正确。

## 决策

**一个服务端插件加一个浏览器插件，由两个新的持久会话事件连接。** `dsh-output-translate` 监听 `turn/end`，找到该回合最后一条含文本的 `assistant/message`，只翻译其 `text` 块，通过一次辅助 `ctx.llm` 调用完成（`purpose: 'output-translate'`，加入可合并扩展的 `GeneratePurposeMap`）。请求在派发前记录为仅日志的 `assistant/translation-request` 事件——满足仓库级规则：任何到达模型请求的内容都必须能从日志重建——结果以 `assistant/translation` 追加并引用源 seq。`dsh-client-ui-output-translate` 为该事件注册一个 `ConversationNodeDefinition` 和 keyed `conversation.chat.node` 渲染器，译文以独立带标签卡片渲染，不触碰助手消息行。

翻译通过 `queueMicrotask` 延迟到 `turn/end` 广播之外：广播运行在会话追加事务内部，从其中追加 `assistant/translation-request` 会触发追加重入保护。幂等性基于日志——已有持久译文的源消息绝不会被翻译两次，因此回放与恢复安全。不变式伴生插件折叠日志，拒绝引用未知、不匹配或无文本源消息的任何译文。

该插件对以本仓库中的 out-of-tree dsh bundle 形式交付（harness 主仓库保持上游干净）：bundle 的补丁层插入 `output-translate` 与 `ui-output-translate` 行，`dsh plugin --profile <name> add <this directory>` 即可安装。

## 测试

`dsh-output-translate/tests/index.spec.ts` 覆盖配置校验、消息选择、请求先于派发的顺序、每种终结 finish 结果、从 `request/header` 继承路由、中止传播以及插件卸载时进行中的翻译。`tests/invariant.spec.ts` 覆盖折叠的接受与拒绝路径，包括晚加载重建。`tests/loader-composition.spec.ts` 通过 Loader 以桩适配器启动插件及其不变式伴生插件，并断言持久译文落盘。浏览器半部分由 `dsh-client-ui-output-translate/tests/` 中的定义、组件与插件生命周期 spec 覆盖。

## 结果

- 每个产生可见文本的已完成回合多一次辅助 LLM 调用；bundle 的补丁层以 `targetLocale: ja` 启用该功能并继承会话路由，后续 patch 层可以禁用该行或更改语言。
- 译文持久且回放安全：恢复与分叉后仍然存在，不变式伴生插件拒绝任何未引用真实含文本源消息的译文。
- 模型派生历史与未安装插件的部署逐字节一致；原始回答与译文在日志中共存。

## 曾考虑的替代方案

**原地改写 `assistant/message` 内容。** 否决：日志只追加，`deriveMessages()` 从日志投影模型历史；替换文本会改变模型在后续步骤看到的内容，并破坏"模型可见 ⟺ 已记录"不变式。

**从 `assistant/chunk` 流式翻译。** 否决：用户要求的是最终输出，且分块翻译既零碎又浪费。

**翻译该回合每条含文本的消息。** 出于成本否决：每回合一次辅助调用是所要求的范围；插件的 `lastTextMessage` 选择使"全部消息"模式成为日后的一行改动。
