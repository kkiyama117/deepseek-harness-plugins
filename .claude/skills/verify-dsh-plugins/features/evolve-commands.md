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

- A DSH checkout whose version satisfies the package's `engines.dsh` (`=0.2.1-rc.3`). On any other version, `dshv up plugins/dsh-evolve` stops at the install with `installation rejected: Plugin @kkiyama117/dsh-evolve@0.1.0 is incompatible with dsh <version>`.
- `dshv up plugins/dsh-evolve` (run `pnpm install --ignore-workspace --ignore-scripts --config.auto-install-peers=false` in the package first if `node_modules` is missing), and doctor shows `include:local-evolve` active.

- **Status.** Run `dshv web "$RUN" fill --role textbox --name "Describe what you want to build" --value "/evolve status"`, then `dshv web "$RUN" click --role button --name "Send message"`. A reply with the mode `observe` appears; capture it with `dshv web "$RUN" snapshot` and `dshv web "$RUN" screenshot evolve-commands/status.png`.
- **No model call.** `dshv logs "$RUN" mock.out` has no new `request` record after the command.
- **Candidates.** Send `/evolve candidates` the same way. The reply reports no candidates.

## Gotchas

- Not yet executed with `dshv`. On 2026-11-09 the checkout was DSH 0.2.2-rc.1 and the install was rejected. `dsh plugin allow-version … --accept-risk` followed by `dsh plugin add` through `dshv exec` installs it into a running run, but the web host does not mount it until it restarts, which `dshv` cannot do, so `/evolve status` went to the model.
- The bundle's default `locale` is `ja`, so replies are in Japanese even in the en-US UI.
- `propose` mode needs a fixed route, limits, and tests in a profile patch, and it calls the model. Against the mock, the candidate text is `mock response recovered`, so it proves the flow, not the quality of a candidate.
