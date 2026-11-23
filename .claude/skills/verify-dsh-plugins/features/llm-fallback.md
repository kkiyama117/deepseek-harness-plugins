# Model fallback on quota or rate limit

When a call to the configured source model fails with a configured error before any content arrives, the bundle re-issues the call to each route model in order until one completes. By default there is one route: `ollama-cloud/glm-5.3-flash` falls back to `openrouter/deepseek/deepseek-v4-flash-0731` on `QUOTA` or `RATE_LIMIT`. The user gets an answer instead of an error. Other models never fall back.

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

- `DSHV_MOCK_SEQUENCE=quota_exceeded,success,success dshv up plugins/llm-fallback`. The third entry serves the session-title call that every headless run also makes.
- An overlay, `fallback.yml`, written after `up` with `MU=$(dshv state "$RUN" mockUrl)`. Both routes point at the mock; the route provider gets a path prefix so `mock.out` shows which route a request took:

```yaml
- id: llm-pi-ai
  config:
    providers:
      ollama-cloud:
        api: anthropic-messages
        baseURL: <MU>
        apiKeyEnv: DEEPSEEK_API_KEY
        models:
          - id: glm-5.3-flash
          - id: glm-5.3
      openrouter:
        api: anthropic-messages
        baseURL: <MU without /v1>/openrouter/v1
        apiKeyEnv: DEEPSEEK_API_KEY
        models:
          - id: deepseek/deepseek-v4-flash-0731
- id: agent-default-model
  config:
    provider: ollama-cloud
    model: glm-5.3-flash
```

- **Fallback run.** Run `dshv headless "$RUN" --patch fallback.yml "Say hello"`. `exitCode` is 0, `finished` is true, and `text` is `mock response recovered`.
- **Side effect.** `dshv logs "$RUN" mock.out` has three `request` records: `quota_exceeded` on `/v1/v1/messages` (the source model), `success` on `/v1/v1/messages` (the session title), and `success` on `/openrouter/v1/v1/messages` (the route model).
- **Control.** On a fresh run with the same sequence, set `agent-default-model` to `glm-5.3`. `exitCode` is 1, the final reason is the quota error, and `mock.out` has two requests (the failure and the title) and none on `/openrouter/`.

## Gotchas

- A profile overlay overrides a row's config with `- id: <row>` and `config:`. There is no `patch:` operation; an unknown shape is ignored silently, and the run then uses `deepseek-official/deepseek-flash`. Check `request/header` in the session log when the result looks unchanged.
- The headless profile's `llm-pi-ai` row has no provider config in `--dump-config`, so write the provider block from scratch as above. `api` is a protocol literal (`anthropic-messages` for the mock), and `apiKeyEnv: DEEPSEEK_API_KEY` uses the key `dshv` puts in the environment. Every model the run selects must be listed under `models`, or it fails with `UNKNOWN_MODEL` before any request.
- `mock.out` records only `attempt`, behavior, and `path`, never the requested model. The path prefix is the only way to tell the routes apart.
- The mock's `quota_exceeded` is a 429, which can classify as `QUOTA` or `RATE_LIMIT`. With the default `fallbackOn`, the run does not prove which; pin `fallbackOn: [QUOTA]` in the overlay to isolate `fallback-quota`.
- This proves the waterfall against a scripted endpoint only. It says nothing about the live OpenRouter or Ollama credentials, quotas, or model ids.
- `DSHV_MOCK_SEQUENCE` is read at `up` time. Changing the sequence needs a new run.
