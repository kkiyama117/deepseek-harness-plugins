# Sandbox facts

Writes one `tool_facts` line to stdout for each `bash` call whose result carries sandbox facts, so a caller of DSH headless `--json` can prove from the tool host (outside the sandbox) how each command was confined. The model-facing text and the headless `tool_result` line stay unchanged ([#76](https://github.com/kkiyama117/deepseek-harness-plugins/issues/76)).

## Line format

```json
{"type":"tool_facts","callId":"<callId>","tool":"bash","sandbox":{"mode":"workspace-write","denied":false,"enforcement":"partial","runnerFailed":false}}
```

- `callId` is the call's `callId`, the same value as the `callId` of its headless `tool_result` line. Join the two by `callId`, never by order: the facts line is written when Core emits `tools/result`, which can come before the `tool_result` line.
- Every key is always present. `mode` is the bash value's `sandbox.mode` as given. `denied` is a boolean. `enforcement` is `"full"`, `"partial"`, or `null` when the value has no `enforcement` key (`danger-full-access`, or a command that was never confined). `runnerFailed` is `true` only when the value says so, `false` when the key is missing. In current Core a foreground runner failure is thrown instead (see below), so `runnerFailed` is `false` in practice; the key stays so that the line shape matches the contract kstack reads.
- No line is written for another tool, a failed call (a sandbox runner failure is thrown, so it is a failed call), a value without `sandbox` (such as a background or promoted job handle), or a value whose sandbox fields are malformed: `mode` not a string, `denied` not a boolean, `enforcement` other than `"full"` or `"partial"` (including an explicit `null` or any other string), or `runnerFailed` not a boolean (including an explicit `null`). A reader must treat a `bash` `tool_result` without a facts line as unknown, never as confined.

## Why it cannot be forged

The plugin writes from the DSH process. A bash command's own stdout and stderr are collected through pipes and reach headless output only JSON-escaped inside a `tool_result` line, so a command cannot print a top-level line.

## Loading

Load it only in headless `--json` runs, because it writes to stdout. Until it is loaded, it does nothing. Loading it in worker runs is a separate kstack change: `run-worker.sh` is to add this row to its run patch, and the package must resolve where `dsh` loads plugins:

```yaml
- insert:
    - id: sandbox-facts
      name: '@kkiyama117/dsh-sandbox-facts'
```

No build step and no runtime dependencies. Tests: `node --test tests/*.test.mjs` (synthetic values only).
