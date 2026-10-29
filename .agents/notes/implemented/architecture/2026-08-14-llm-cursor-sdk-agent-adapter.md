# Agent Note: Cursor SDK agent adapter for the LLM seam

Status: implemented

English | [中文](2026-08-14-llm-cursor-sdk-agent-adapter.zh.md)

## Problem

The harness LLM seam (`ctx.llm`) speaks a provider-neutral streaming vocabulary, and its two shipping adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai` — the [twin-adapters design](https://github.com/deepseek-ai/deepseek-harness/blob/main/.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md)) both model a *model endpoint*: the provider returns text, reasoning, and tool calls that the harness loop executes. Cursor does not fit that shape. Cursor's product is an *agent loop* — the Cursor SDK (`@cursor/sdk`) runs its own tools, its own session, and its own model selection inside a `Run`. Translating Cursor into an OpenAI-shaped endpoint (the proxy approach) loses the agent loop, which is the entire point of using Cursor; the reference Pi extension (`pi-cursor-sdk`) deliberately keeps "Cursor remains Cursor" by running the SDK's agent loop inside its provider's `streamSimple`.

## Decision

Ship `@kkiyama117/dsh-llm-cursor` as an out-of-tree dsh bundle in this repository, a third `LlmAdapter` that treats one Cursor agent run as one harness model call:

- **The Cursor agent loop stays intact inside the adapter.** Each `stream()` call creates (or resumes) a Cursor agent, sends the flattened harness conversation as one prompt, and streams the run. The harness sees reasoning, text, and usage only; the agent's internal tool activity is opaque, exactly like a subagent's. Harness tool schemas are never sent, and SDK `tool_call`/`tool_use` events are deliberately NOT replayed as harness tool-call blocks — the harness would execute them a second time.
- **Session continuity rides the seam's replayState.** A successful finish stores `{ kind: 'cursor', version: 1, agentId }`; the next ordinary conversation request resumes that agent (`Agent.resume`) and sends only the latest user message. The Cursor agent's own conversation therefore survives harness turns and process restarts (the local `JsonlLocalAgentStore` persists under `stateRoot`). Auxiliary calls (`purpose: compaction`/`session-title`) always run on a fresh agent so they can never pollute a resumed conversation.
- **The adapter is transport-only, like its twins.** Connection facts resolve through a thunk once per operation (settings-layered, credentials-resolved), the retry policy is the one registration-captured fact, and the route registers as `cursor` with a configurable-provider directory entry and catalog-first model discovery — the configured catalog answers without a credential, and the live Cursor SDK catalog (`Cursor.models.list()`) answers when the draft or the route's stored key provides one.
- **Sampling knobs are rejected, not dropped.** `stop`, `temperature`, `maxTokens`, and `reasoningEffort` throw `UNSUPPORTED_OPTION` because the SDK `send` has no wire equivalent; the agent loop sends none by default, so the rejection only fires for explicit configuration.

## Alternatives considered

- **An OpenAI-compatible Cursor proxy** — a generic `/v1` endpoint for many clients, but it translates Cursor's agent behavior into OpenAI-shaped requests and loses the agent loop; the reference extension rejects it for exactly this reason.
- **Replaying Cursor tool calls into the harness loop** — the harness would execute the agent's already-executed tools a second time, with results the model never sees; the session log would lie about what happened.
- **A fresh agent per call, always** — simpler, but every turn would re-send the flattened history and lose Cursor's native session memory, which is the product's value.
- **Shipping inside the harness main body** — the harness repo keeps its adapter family deliberate (the twin-adapters design); a third adapter backed by a proprietary SDK belongs out-of-tree, installable as a bundle, so the main body stays upstream-clean.

## Consequences

The harness gains a third adapter family — a *subagent-style* model backend where the provider owns the loop — without the main body carrying it: the bundle's patch layer inserts the `llm-cursor` row, and `dsh plugin --profile <name> add <this directory>` installs it. The session log records the flattened prompt and the agent's reasoning/text/usage — the agent's internal tool activity is not reconstructable from the log, which is the same honesty boundary a subagent delegation has. The adapter pins `@cursor/sdk@1.0.23` exactly (the SDK ships platform-specific optional binaries; the pin matches the reference extension). Known gaps are tracked in the package README: attribution headers are not injectable through the SDK's transport, harness tools are not bridged into the agent (the Pi MCP-bridge pattern is the future work), and a cleared store breaks session continuity loudly rather than silently restarting.
