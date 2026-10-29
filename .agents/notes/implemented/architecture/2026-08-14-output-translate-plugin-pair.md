# Agent Note: Durable final-answer translation as a plugin pair

Status: implemented

English | [中文](2026-08-14-output-translate-plugin-pair.zh.md)

## Problem

A user of the Web GUI wants the agent's final answer shown in Japanese while the model's thinking stays exactly as produced. The output the user sees is the settled `assistant/message` rendered from the session log, and the log is the single source of truth for both the UI and the model's derived history — so a translation feature must not rewrite the message, must not leak into `deriveMessages()`, and must survive replay and resume.

## Decision

**A server plugin plus a browser plugin, joined by two new durable session events.** `dsh-output-translate` watches `turn/end`, finds the last text-bearing `assistant/message` of the turn, and translates only its `text` blocks through one auxiliary `ctx.llm` call (`purpose: 'output-translate'`, added to the merge-extensible `GeneratePurposeMap`). The request is recorded as the log-only `assistant/translation-request` event before dispatch — the repo-wide rule that anything reaching a model request is reconstructable from the log — and the result is appended as `assistant/translation` citing the source seq. `dsh-client-ui-output-translate` registers a `ConversationNodeDefinition` for that event and a keyed `conversation.chat.node` renderer, so the translation renders as its own labeled card without touching the assistant row.

The translation is deferred out of the `turn/end` broadcast with `queueMicrotask`: the broadcast runs inside the session's append transaction, and appending `assistant/translation-request` from inside it would hit the append-reentrancy guard. Idempotency is log-based — a source that already has a durable translation is never translated twice, which makes replay and resume safe. The invariant companion folds the log and rejects any translation that cites an unknown, mismatched, or text-less source message.

The pair ships as an out-of-tree dsh bundle in this repository (the harness main body stays upstream-clean): the bundle's patch layer inserts the `output-translate` and `ui-output-translate` rows, and `dsh plugin --profile <name> add <this directory>` installs it.

## Testing

`dsh-output-translate/tests/index.spec.ts` covers config validation, message selection, the request-before-dispatch ordering, every terminal finish outcome, route inheritance from `request/header`, abort propagation, and plugin disposal mid-flight. `tests/invariant.spec.ts` covers the fold's accept and reject paths including late-load reconstruction. `tests/loader-composition.spec.ts` boots the plugin and its invariant companion through the Loader with a stub adapter and asserts the durable translation lands. The browser half is covered by definition, component, and plugin-lifecycle specs in `dsh-client-ui-output-translate/tests/`.

## Consequences

- Every completed turn that produced visible text costs one auxiliary LLM call; the bundle's patch layer enables the feature with `targetLocale: ja` and inherits the session's route, and a later patch layer can disable the row or change the locale.
- The translation is durable and replay-safe: it survives resume and fork, and the invariant companion rejects any translation that does not cite a real text-bearing source message.
- The model's derived history is byte-identical to a deployment without the plugin; the original answer and the translation coexist in the log.

## Alternatives considered

**Rewrite the `assistant/message` content in place.** Rejected: the log is append-only and `deriveMessages()` projects model history from it; replacing the text would change what the model sees in later steps and break the model-visible-⟺-logged invariant.

**Translate mid-stream from `assistant/chunk`.** Rejected: the user asked for the final output, and chunk-level translation would be choppy and wasteful.

**Translate every text-bearing message of the turn.** Rejected for cost: one auxiliary call per turn is the requested scope; the plugin's `lastTextMessage` selection makes an "all messages" mode a one-line change later.
