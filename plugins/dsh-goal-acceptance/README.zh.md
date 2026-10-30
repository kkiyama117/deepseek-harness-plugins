---
description: "可选的原始请求保留、教训决策记录，以及 Goal 完成和初始委派提示的证据检查。"
kind: "package-bundle"
---

# @kkiyama117/dsh-goal-acceptance

[English](README.md) | 中文

## 概述

将人工引文与推断的目标、示例、执行环境和获取的材料分开。设计、委派、失败修复和完成前记录验收条件。插件拒绝缺失引用、删除已保留验收条件、无依据的目标升级，以及没有结果观察的 Goal 完成。它将已保留请求传入初始子级提示，不调用评估模型。这些检查强制记录一致性，不保证语义真实。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 Plugin Manager 安装此显式启用的 bundle。其 patch 禁用官方 `goal` 和 `subagent` 行，并插入 `acceptance-goal-provider` 和 `acceptance-subagent-provider`。上游服务类保持不变。策略需要这些提供方以及工具、系统提示、Session 投影和异步 Session 查询服务。以下 patch 配置已安装的策略行。

```yaml
- id: goal-acceptance
  config:
    maxRecordBytes: 16384
    sessionIds: [session-example]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxRecordBytes` | `16384` | 完整已接受检查点的最大 UTF-8 字节数，包括 Goal 身份；超限失败，不截断 |
| `sessionIds` | `all` | 参与检查的精确 Session id；空列表不选择任何会话。共享 Host 试用应使用显式列表 |

将非默认的 Goal/subagent 配置复制到替换行的 id；禁用行的配置不会继承。已部署的 pilot wrapper 保留 `maxDepth: 2` 和精确的 Session id 列表。使用该 wrapper 时，不要同时选择此适用于所有 Session 的独立策略。Loader patch 不能通过设置 `name` 重命名行。

不提供检查点时调用 `request_check`，读取已保留请求、最新人工事件序号、缺失项和过期状态。提供检查点时记录人工引文、验收项、目标来源、观察和教训决策。引用在所属 Session 内解析，不读取外部文件或其他 Session。成功的 `kura_read` 引用将记录关联到已记录调用；它不认证返回记忆的存在或完整性。模型记录哪个决策发生变化或为何未应用教训。不注入记忆正文。

限制范围的目标需要引用包含其值的直接人工消息。已记录为非人工来源的值，在升级前需要后续人工确认。常规可逆补充和不限制范围的推断目标不需要确认。此验证不能判断人工提及是否实际指定了目标。

对于已保留 Goal，检查点不能替换原始请求，或删除、重写现有验收项。应添加新项，而不是缩小旧项。每项保留其人工来源序号，包括中间消息。直接人工消息、Goal 目标编辑或失败工具结果使检查点过期。新检查点确认最新人工序号；理解新指令仍由模型负责。常规状态读取不会清除过期状态。

完成需要绑定精确 Goal id 和目标文本的当前 `complete` 检查点。每项必须为 `satisfied` 或 `negative`，并引用已有成功工具结果中的 `outcome` 观察。`not-applicable`、`missing`、待完成工作以及仅机械证据仍表示未完成。负面观察可以满足验收；shell 退出零和子级报告完成不是经独立认证的结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

已接受检查点保存在现有 native `tool/result` 元数据或嵌套的 `tool/ptc-dispatch` 结果正文中。投影只接受匹配的检查点写入调用、参数摘要和最新已检查人工序号。尚无 Goal 的设计检查点在随后创建 Goal 时保留；完成、清除或替换已有 Goal 则开始新的验收记录。没有 Goal 的已完成检查点，也可在后续人工请求后开始新记录。引用验证异步读取精确事件，不读取完整日志。仅 Host 使用的 Session 投影逐事件处理已提交记录，不依赖当前模型历史视图。因此恢复、fork 和历史视图压缩会保留检查点，不使用进程共享的就绪标志。外部 Goal 提供方在调用上游修改操作前检查完成条件，覆盖直接调用和 Remote 调用。外部 subagent 提供方向初始一次性和可续接提示追加有界原始请求摘要；子级结算不更新父级验收。

激活会等待保留的投影句柄就绪后再发布工具或策略。投影初始化失败时不会发布这些操作；状态读取使用保留的句柄。

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 工具、投影、完成策略和初始委派上下文 |
| [src/check.ts](src/check.ts) | 引文、来源、保留项和证据检查 |
| [src/schema.ts](src/schema.ts) | 有界检查点和重放验证 |
| [src/goal-provider.ts](src/goal-provider.ts) | 上游 Goal 子类和完成策略注册 |
| [src/subagent-provider.ts](src/subagent-provider.ts) | 上游 subagent 子类和初始上下文注册 |
| [bin/audit-session.py](bin/audit-session.py) | 只读路由和有界事故提取；排除提供方重放数据和原始导出 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Goal 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/goal.zh.md) — Goal 操作和生命周期。
- [Goal 提供方](src/goal-provider.ts) — 外部完成策略注册。
- [Subagent 提供方](src/subagent-provider.ts) — 初始提示上下文和子级生命周期。
- [Session 投影服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection/README.zh.md) — 增量重放和检查点归属。

-----

<a id="model-experience"></a>
## 模型体验

### 检查点工具 schema

#### 模型看到什么

[request_check 声明](src/index.ts) 和包含保留记录、缺失项目 id、过期状态及有界最新人工引文的 JSON 结果。

#### Token 影响

显式挂载增加一个稳定工具 schema；检查点调用追加有界结果。读取状态也返回当前记录，但不改变验收。

#### KV Cache 影响

schema 在常规 step 间保持不变。挂载或卸载会改变可用工具集合；结果历史遵循正常追加和压缩行为。

### 检查点指导与保留请求

#### 模型看到什么

以下指导，以及接受检查点后包含原始引文、项目 id、人工引文、模型编写的验收文本和目标分类的摘要。

##### 指导原文

```markdown
Use request_check before detailed design, delegation, repair after failure, and completion. Keep original human quotations and acceptance items; label targets as human, inferred, example, environment, material, or unresolved. Routine reversible details need no human confirmation. A scope restriction needs a human-specified target. Record outcome observations separately from process/test/tool success, and connect each retrieved lesson to a changed decision or explain non-application. A child reporting done is not parent acceptance. Before claiming completion, record a complete checkpoint with outcome evidence for every item. request_check validates citations and retained conditions, not the truth or semantic relevance of model judgments.
```

#### Token 影响

显式挂载会增加固定指导。已接受检查点及其有界摘要增加数据相关 token。内容不变的常规 step 不追加提醒或记忆正文。插件不调用模型；必需检查点或拒绝过早完成可能增加任务 step。

#### KV Cache 影响

未变化的指导和摘要保留其文本。检查点更新会改变系统贡献，根据所选提供方的提示能力影响前缀复用。工具结果保留为只追加历史，直到正常压缩。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些检查限制记录不一致，不替代模型判断。

- 模型选择首次验收项并分类来源和证据。精确引文及保留的 id 不能证明完整性、权限、事实真实或语义相关性。误导性的 `outcome` 标注仍可能通过。
- 设计和修复检查点是指导，不拦截每次文件编辑。Goal 完成和初始委派被强制检查；不调用 Goal 完成的任意最终文本不会被改写或扣留。
- `complete: true` 的 persona 按设计抑制其他系统提示节，包括本插件的指导和父级摘要。完成检查、工具注册及初始委派验证仍执行。需要指导时应使用正常组合的提示。
- `sessionIds: all` 将策略应用到该组合中的每个 Goal，包括已有 Session。显式 id 列表将完成检查、委派上下文、指导和工具可见性限制在这些 Session；子级和 fork 不自动入选。空列表不启用检查。卸载会移除作用域工具。不迁移已有 Goal 历史。显式启用后完成旧 Goal，需要引用其保留的直接人工来源的新检查点。
- 初始子级提示收到父级摘要；后续子级消息和没有检查点的递归子级不会自动收到更新的父级验收。外部提供方必须履行记录提示投递的义务。
- 插件不选择模型、不重试、不计量费用、不扩充预算，也不认证提供方内部路由。Harness 请求 header 和 assistant 来源是可观察记录，不是提供方内部保证。
- 受信任插件可以伪造工具结果元数据。卸载此可选策略会移除完成检查；它不是安全 sandbox。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
