# Codex transport recovery

Corrects only `openai-codex` terminal errors classified as `PI_AI_ERROR` whose message is `WebSocket closed 1000` or `WebSocket closed 1012` (optionally followed by the close reason). Code 1012 denotes service restart; it does not identify which server or intermediary caused the restart. pi-ai emits that failure only when the socket closes before a terminal response event. The official `llm/stream` waterfall changes its code to `TRANSPORT`; the original message and other fields remain intact.

The package does not retry, change models, alter requests, suppress errors, or increase budgets. The official `llm-retry` executor retains ownership: a normal provider policy permits at most its configured retries (default five). Authentication failures, close 1009/message-too-big, other codes, completed responses, and other providers are unchanged. A persistent failure still terminates the turn after the retry budget. This fixes recovery eligibility, not the underlying server/network reason for closing the connection.

Install as a DSH bundle. No build scripts or runtime dependencies are required. Cordis disposes the listener when the bundle is disabled. Remove this package when the official pi-ai adapter classifies this exact failure correctly and the regression tests pass without it.

Verification: `node --test tests/*.test.mjs` checks the corrected case, unchanged cases, streamed content, metadata, delegation to the downstream stream, and effect ownership. Real provider disconnect frequency is not simulated by those tests.
