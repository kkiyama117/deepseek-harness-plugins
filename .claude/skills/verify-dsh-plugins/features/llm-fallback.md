# Model fallback on quota or rate limit

When a call to the configured source model fails with a configured error before any content arrives, the bundle sends the same call once to the route model. By default, `ollama-cloud/glm-5.3-flash` falls back to `openrouter/deepseek/deepseek-v4-flash-0731` on `QUOTA` or `RATE_LIMIT`. The user gets an answer instead of an error. Other models never fall back.

## Sub-features

- `fallback-quota` answers through the route model after a `QUOTA` failure on the source model.
- `fallback-ratelimit` does the same after `RATE_LIMIT`.
- `fallback-other-error` passes any other error through unchanged.
- `fallback-other-model` leaves a non-source model's failure unchanged.
- `fallback-after-content` does not fall back once content has streamed.

## How to get to it (user POV)

- Chat in the web UI, or run `dsh --profile headless`, with the agent model set to the source model while its provider is over quota.

## Driving it with dshv

Preconditions:

- `DSHV_MOCK_SEQUENCE=quota_exceeded,success dshv up plugins/llm-fallback`.
- An overlay patch, `fallback.yml`, written by hand: the fresh profile's `llm-pi-ai` row has no providers to copy. `<origin>` is `$(dshv state "$RUN" mockUrl)` without its trailing `/v1`, because the Messages client appends `/v1/messages` itself. `DEEPSEEK_API_KEY` is `mock-key` in the run. An explicit `models` list replaces the catalog, so declare the control's `glm-5.3` too, or the control fails with `UNKNOWN_MODEL` before any request.

  ```yaml
  - id: llm-pi-ai
    config:
      providers:
        ollama-cloud:
          api: anthropic-messages
          baseURL: <origin>
          apiKeyEnv: DEEPSEEK_API_KEY
          models: [{ id: glm-5.3-flash }, { id: glm-5.3 }]
        openrouter:
          api: anthropic-messages
          baseURL: <origin>
          apiKeyEnv: DEEPSEEK_API_KEY
          models: [{ id: deepseek/deepseek-v4-flash-0731 }]
  - id: agent-default-model
    config:
      provider: ollama-cloud
      model: glm-5.3-flash
  ```

- **Fallback run.** Run `dshv headless "$RUN" --patch fallback.yml "Say hello"`. `exitCode` is 0, `finished` is true, and `text` is `mock response recovered`.
- **Side effect.** `dshv logs "$RUN" mock.out` has `request` records `quota_exceeded`, then `success` (the route), then one more for the session title. The mock does not record the model. The session store does: `zstdcat $(dshv state "$RUN" run)/home/.dsh/sessions/*/<sessionId>/session.v4.jsonl.zstd` shows `"provider":"openrouter"` and `"model":"deepseek/deepseek-v4-flash-0731"` next to the `ollama-cloud` request.
- **Control.** Repeat on a fresh run with `agent-default-model` set to `ollama-cloud` / `glm-5.3`. `exitCode` is 1 and `text` is empty; the saved transcript and the session store carry `"code":"QUOTA"`. `mock.out` has the `quota_exceeded` request and the session-title request only, and the session store has no `openrouter` entry.

## Gotchas

- This proves the waterfall against a scripted endpoint only. It says nothing about the live OpenRouter or Ollama credentials, quotas, or model ids.
- `DSHV_MOCK_SEQUENCE` is read at `up` time. Changing the sequence needs a new run.
