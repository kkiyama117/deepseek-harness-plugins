# pi-ai server error recovery

Corrects only terminal model-request errors with the code `PI_AI_ERROR`, which only the pi-ai adapter emits, whose message carries a 5xx status as text without the numeric code: `Internal Server Error`, `Bad Gateway`, `Service Unavailable`, or `servers are currently overloaded`. `Gateway Timeout` is not on the list: pi-ai already maps it to the retryable `TIMEOUT`. The official `llm/stream` waterfall changes its code to `SERVER`; the original message and every other field remain intact. pi-ai's own classifier (`classifyPiAiError` in `@deepseek-ai/dsh-llm-pi-ai`) recognizes a 5xx failure only by its three-digit code, so these failures otherwise end the turn without a retry ([#53](https://github.com/kkiyama117/deepseek-harness-plugins/issues/53)).

The package does not retry, change models, alter requests, suppress errors, or increase budgets. The official `llm-retry` executor keeps ownership: `SERVER` is in the default `retryableCodes`, and the provider's `retryPolicy` bounds the retries. Other codes, other messages, completed responses and streamed content are unchanged. A persistent failure still ends the turn after the retry budget.

Install as a DSH bundle. No build scripts or runtime dependencies are required. Cordis disposes the listener when the bundle is disabled. Remove this package when the official pi-ai adapter classifies these failures as `SERVER` and the regression tests pass without it.

Verification: `node --test tests/*.test.mjs` checks each corrected phrase, unchanged cases, streamed content, metadata, and delegation to the downstream stream. Real provider failures are not simulated by those tests.
