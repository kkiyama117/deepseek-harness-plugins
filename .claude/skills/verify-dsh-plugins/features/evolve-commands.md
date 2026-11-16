# Evolve human commands

DSH Evolve watches tool failures and repeated calls. A human manages it with `/evolve` commands typed in the composer. In the default `observe` mode, the commands report state and make no LLM calls. The model sees only the read-only `evolve_inspect` tool.

## Sub-features

- `evolve-status` shows the mode, the applied revision per asset, the daily quota, and storage health.
- `evolve-candidates` lists stored candidates. In `observe` mode the list is empty.
- `evolve-history` lists recent human actions.
- `evolve-show` (`/evolve show <id>`) shows one candidate.
- `evolve-cycle` generates and tests a candidate, in `propose` mode only.
- `evolve-approve`, `evolve-reject`, and `evolve-rollback` change which revision is applied.

## How to get to it (user POV)

- In the web UI, type `/evolve status` (or another verb) in the composer `Describe what you want to build, / commands, @ files or sessions` and choose `Send message`.

## Driving it with dshv

Preconditions:

- A DSH runtime that the manifest's `engines.dsh` allows (`=0.2.1-rc.3`). On any other version, `dshv up` fails at install with `installation rejected: Plugin @kkiyama117/dsh-evolve@0.1.0 is incompatible with dsh <version>`; report the feature as unreachable with that line.
- `dshv up plugins/dsh-evolve` (run `pnpm install --ignore-workspace --ignore-scripts --config.auto-install-peers=false` in the package first if `node_modules` is missing), and doctor shows `include:local-evolve` and `include:preset-evolve-trial` active.

- **Status.** Run `dshv web "$RUN" fill --role textbox --name "Describe what you want to build" --value "/evolve status"`, then `dshv web "$RUN" click --role button --name "Send message"`. A JSON reply with `"mode": "observe"` and `"candidateCount": 0` appears; capture it with `dshv web "$RUN" snapshot` and `dshv web "$RUN" screenshot evolve-commands/status.png`.
- **No model call.** `dshv logs "$RUN" mock.out` has no new `request` record after the command.
- **Candidates.** Send `/evolve candidates` the same way. The reply is `[]`. In `observe` mode, `/evolve cycle` answers with `[OBSERVE_ONLY]`.

## Gotchas

- Not yet executed with `dshv`. On 2026-11-16 the checkout was DSH `0.2.2-rc.1` and the install was rejected; the rc.1 upgrade (#74) did not include this package.
- Successful replies are pretty-printed JSON and are not localized. Only errors, hints, and descriptions follow the default `locale: ja`, so they are in Japanese even in the en-US UI.
- `propose` mode needs a fixed route, limits, and tests in a profile patch, and it calls the model. Against the mock, the candidate text is `mock response recovered`, so it proves the flow, not the quality of a candidate.
