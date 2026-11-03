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
- An overlay patch, `fallback.yml`, that points both `ollama-cloud` and `openrouter` providers of the `llm-pi-ai` row at `$(dshv state "$RUN" mockUrl)` with a Messages-compatible API and key `mock-key`, declares the models `glm-5.3-flash` and `deepseek/deepseek-v4-flash-0731`, and sets `agent-default-model` to `ollama-cloud` / `glm-5.3-flash`. Start from the `llm-pi-ai` provider block in `dshv exec "$RUN" -- dsh --profile headless --dump-config`, or from your own profile's `cordis.patch.yml`, with the URLs and keys replaced.

- **Fallback run.** Run `dshv headless "$RUN" --patch fallback.yml "Say hello"`. `finished` is true, and `text` is `mock response recovered`.
- **Side effect.** `dshv logs "$RUN" mock.out` has two `request` records: `quota_exceeded` then `success`. If the mock records the requested model, the second request names the route model.
- **Control.** Repeat on a fresh run with `agent-default-model` set to `ollama-cloud` / `glm-5.3`. The run reports the quota error, and `mock.out` has one request.

## Gotchas

- Not yet executed with `dshv`. The provider overlay is the uncertain part: confirm that `llm-pi-ai` accepts a Messages-compatible API pointed at the mock, and record the working overlay here.
- This proves the waterfall against a scripted endpoint only. It says nothing about the live OpenRouter or Ollama credentials, quotas, or model ids.
- `DSHV_MOCK_SEQUENCE` is read at `up` time. Changing the sequence needs a new run.
