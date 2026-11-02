# Acceptance pilot isolation

`@local/dsh-acceptance-pilot-isolation` is a disposable test fixture, not a production Goal policy or a shared preset change. It supports deterministic acceptance checks for the [request acceptance pilot](../dsh-request-acceptance-pilot/README.md).

## Behavior

[cordis.patch.yml](cordis.patch.yml) inserts one row, `acceptance-pilot-isolation`. For exactly the two synthetic Session ids hard-coded in [index.js](index.js), the plugin:

- disarms automatic Goal rounds when the agent mounts and whenever its Goal changes;
- adds a `deployment:persona-prefix` system-prompt section stating that the Session is a labeled synthetic fixture with no real article results or paid model calls.

Every other Session keeps ordinary behavior.

## Limits

- `index.js` imports `createScope` from an absolute path in the maintainer's DSH checkout (`/data/softwares/deepseek-harness/...`). It does not load on another machine without editing that path.
- The Session ids are fixed. Do not widen them to test a real deployment; create fresh fixture Sessions instead.
- The row is meant to be temporary. Disable the bundle through Plugin Manager after the acceptance check.
