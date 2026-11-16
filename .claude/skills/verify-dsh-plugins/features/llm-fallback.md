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

- `DSHV_MOCK_SEQUENCE=quota_exceeded,success dshv up plugins/llm-fallback`, and doctor shows `include:llm-fallback` active.
- An overlay patch, `fallback.yml`, outside the repository. The mock speaks the Anthropic Messages API only, and the headless profile reads the key from the environment, which `dshv` sets to the mock's URL and key:

  ```yaml
  - id: llm-pi-ai
    config:
      providers:
        ollama-cloud:
          api: anthropic-messages
          baseURL: !!js process.env.DEEPSEEK_BASE_URL.replace(/\/v1$/, '')
          apiKeyEnv: DEEPSEEK_API_KEY
          models: [{ id: glm-5.3-flash }, { id: glm-5.3 }]
        openrouter:
          api: anthropic-messages
          baseURL: !!js process.env.DEEPSEEK_BASE_URL.replace(/\/v1$/, '')
          apiKeyEnv: DEEPSEEK_API_KEY
          models: [{ id: deepseek/deepseek-v4-flash-0731 }]
  - id: agent-default-model
    config: { provider: ollama-cloud, model: glm-5.3-flash }
  ```

  `dshv exec "$RUN" -- dsh --profile headless --patch fallback.yml --dump-config` shows both providers and the default model.

- **Fallback run (`fallback-quota`).** Run `dshv headless "$RUN" --patch fallback.yml "Say hello"`. `exitCode` is 0, `finished` is true, and `text` is `mock response recovered`.
- **Side effect.** `dshv logs "$RUN" mock.out` has the `request` records `quota_exceeded`, `success`, then one more `success`. The last one is an auxiliary request that the control also makes; it is not a fallback. The records do not name the model.
- **Rate limit (`fallback-ratelimit`).** Repeat on a fresh run with `DSHV_MOCK_SEQUENCE=rate_limit,success`. The result is the same.
- **Control (`fallback-other-model`).** On a fresh run with `quota_exceeded,success`, use a copy of the overlay with `model: glm-5.3`. `exitCode` is 1, `text` is empty, the transcript reports the `QUOTA` error, and `mock.out` has `quota_exceeded` and the auxiliary `success` only.
- **Other error (`fallback-other-error`).** On a fresh run with `DSHV_MOCK_SEQUENCE=auth_error,success` and the original overlay, `exitCode` is 1 and `text` is empty.
- **After content (`fallback-after-content`).** Unreachable with the mock: no behavior streams content and then fails with `QUOTA` or `RATE_LIMIT`. `partial_disconnect` is recovered by DSH's own stream retry, so it does not test this bundle.

## Gotchas

- This proves the waterfall against a scripted endpoint only. It says nothing about the live OpenRouter or Ollama credentials, quotas, or model ids.
- `DSHV_MOCK_SEQUENCE` is read at `up` time. Changing the sequence needs a new run.
- `ollama-cloud` is not in the built-in provider catalog, so the overlay must declare its `api`, `baseURL`, and `models` itself.
