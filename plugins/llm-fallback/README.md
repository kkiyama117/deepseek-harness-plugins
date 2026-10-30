# llm-fallback

This Host bundle retries only the configured source provider/model on its explicit route list, and only after a configured error before content. The bundled policy maps `ollama-cloud/glm-5.3-flash` to `openrouter/deepseek/deepseek-v4-flash-0731` for QUOTA or RATE_LIMIT. Other requested models are not substituted. Production policy is in `cordis.patch.yml`.

Run pure tests and the real-Cordis waterfall smoke against the exact built deployment:

```sh
DSH_UPSTREAM_ROOT=/path/to/built/dsh node --test plugins/llm-fallback/test.mjs plugins/llm-fallback/mount.test.mjs
```

The mount test requires an explicit checkout so the plugins repository's older Cordis dependency cannot silently stand in for the upgraded runtime. Its provider responses are synthetic; it does not verify live model or credential availability.
