# Acceptance pilot isolation

`@local/dsh-acceptance-pilot-isolation` is a disposable test fixture, not a production Goal policy or a shared preset change; it supports deterministic acceptance checks for the request acceptance pilot, which [#72](https://github.com/kkiyama117/deepseek-harness-plugins/issues/72) removed.

## Behavior

[`cordis.patch.yml`](cordis.patch.yml) inserts one row, `acceptance-pilot-isolation`. For exactly two synthetic Session ids hard-coded in [`index.js`](index.js) it disarms automatic Goal rounds when the agent mounts and whenever its Goal changes, and adds a `deployment:persona-prefix` system-prompt section saying the Session is a labeled synthetic fixture with no real article results or paid model calls. Other Sessions keep ordinary behavior.

## Limits

[`index.js`](index.js) imports `createScope` from an absolute path in the maintainer's DSH checkout, so it does not load on another machine without editing that path; the Session ids are fixed — do not widen them to test a real deployment, create fresh fixture Sessions instead; the row is temporary — disable the bundle through Plugin Manager after the check.
