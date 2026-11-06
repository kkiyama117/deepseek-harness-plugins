# Evolve human commands

DSH Evolve watches tool failures and repeated calls. A human manages it with `/evolve` commands typed in the composer. In the default `observe` mode, the commands report state and make no LLM calls. The model sees only the read-only `evolve_inspect` tool.

## Sub-features

- `evolve-status` shows the mode, the applied revision per asset, the daily quota, and storage health.
- `evolve-candidates` lists stored candidates. In `observe` mode the list is empty.
- `evolve-history` lists recent human actions.
- `evolve-cycle` generates and tests a candidate, in `propose` mode only.
- `evolve-approve`, `evolve-reject`, and `evolve-rollback` change which revision is applied.

## How to get to it (user POV)

- In the web UI, type `/evolve status` (or another verb) in the composer `Describe what you want to build, / commands, @ files or sessions` and choose `Send message`.

## Driving it with dshv

Preconditions:

- `dshv up plugins/dsh-evolve` (run `pnpm install --ignore-workspace --ignore-scripts --config.auto-install-peers=false` in the package first if `node_modules` is missing), and doctor shows `include:local-evolve` and `include:preset-evolve-trial` active.

- **Status.** Run `dshv web "$RUN" fill --role textbox --name "Describe what you want to build" --value "/evolve status"`, then `dshv web "$RUN" click --role button --name "Send message"`. A reply with the mode `observe` appears; capture it with `dshv web "$RUN" snapshot` and `dshv web "$RUN" screenshot evolve-commands/status.png`.
- **No model call.** `dshv logs "$RUN" mock.out` has no new `request` record after the command.
- **Candidates.** Send `/evolve candidates` the same way. The reply reports no candidates.

## Gotchas

- Not yet executed with `dshv`. The package declares DSH `0.2.1-rc.3`; the checkout is newer, so check doctor for a `failed` row before driving.
- The bundle's default `locale` is `ja`, so replies are in Japanese even in the en-US UI.
- `propose` mode needs a fixed route, limits, and tests in a profile patch, and it calls the model. Against the mock, the candidate text is `mock response recovered`, so it proves the flow, not the quality of a candidate.
