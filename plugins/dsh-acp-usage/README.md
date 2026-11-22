# ACP usage

Writes one token-usage line to stderr and appends one JSONL record for each finished turn of every Session in the process, root and subagent alike. The `acp` profile loads it so a consumer such as kstack's card runner can read the usage of an ACP turn after the process exits ([#102](https://github.com/kkiyama117/deepseek-harness-plugins/issues/102)).

## Line format

```text
dsh: usage: session=c1 parent_session=s1 cwd=/w steps=2 input=120 output=15 cache_read=200 cache_write=0 reasoning=5
```

`sanitize` escapes a newline as `\n`, a carriage return as `\r`, and any other control character as a space, so a value never splits the line. `first_request_input`, `ts`, `provider`, `model` and `reasoning_effort` are not on the line. The line is for people reading stderr and deliberately differs from kstack's own `dsh: usage:` line (`first_context` and `brief_bytes` are absent). The consumer parses only the JSONL record.

## Record format

```json
{"ts":"2026-11-22T00:00:00.000Z","session":"c1","parent_session":"s1","cwd":"/w","provider":"p1","model":"m1","reasoning_effort":"high","steps":2,"input":120,"output":15,"cache_read":200,"cache_write":0,"reasoning":5,"first_request_input":150}
```

Keys are in this order. `ts`, `session`, `cwd`, `provider`, `model`, `reasoning_effort` and `steps` are always present. `ts` is the time at `turn/end`. `session` is the Session id. `cwd` is the realpath of the Session's cwd, the value as given when it cannot be resolved, or `''` when it is not a string. `provider`, `model` and `reasoning_effort` come from the request header in force at `turn/end`, and are `''` when absent, not a string, or unreadable. `steps` counts the turn's `step/end` events.

Optional keys:

- `parent_session` is present only for a subagent Session (`header.origin === 'subagent'`). It is the direct creator's id, or `''` when the header has none. A nested subagent records its parent subagent, not the root; chain records by `session` to reach the root. An ordinary fork carries no `parent_session` even when its header has one.
- `input`, `output`, `cache_read`, `cache_write` and `reasoning` are present only when at least one step of the turn reported a valid value for that bucket. A valid value is a finite number of at least zero. A zero is reported and kept, so `cache_write: 0` means a reported zero, not an absent bucket. A turn with no reported step has none of them.
- `first_request_input` is present only when the first step reported at least one valid value. It is kstack's `firstContext`, the first step's input plus cache-read plus cache-write, with a bucket the step did not report counted as zero. A first step that reports only output has `first_request_input: 0`.
- `incomplete: true` is present only when the turn is incomplete: a step ended without a complete usage, or without any valid value. The key is absent on a complete turn.

No other key appears. Message text, tool data and paths other than `cwd` are never recorded.

## Loading

Load it in the `acp` profile with a `file` so the records outlive the process:

```yaml
- insert:
    - id: acp-usage
      name: '@kkiyama117/dsh-acp-usage'
      config:
        file: /absolute/path/to/usage.jsonl
```

`file` must be absolute. The plugin creates its parent directory and appends one line per record with mode `0600`. Without `file` the plugin writes stderr only. The `acp` install must set `config.file`, because under T3 Code the process's stderr goes to T3 Code rather than to the card runner. The plugin reads no Session files; it subscribes to committed `session/event` events in the process.

No build step and no runtime dependencies. Tests: `node --test tests/*.test.mjs` (synthetic events only, temporary directories only).
