# Evolve human commands

DSH Evolve watches tool failures and repeated calls. A human manages it with `/evolve` commands typed in the composer. In the default `observe` mode, the commands report state and make no LLM calls. The model sees only the read-only `evolve_inspect` tool. A successful command replies with the result as JSON; errors and the input hint follow the bundle's `locale`.

## Sub-features

- `evolve-status` shows the mode, whether a cycle is running, storage health, the daily budget and `dailyRequestLimit` (`null` unless configured), the applied revision per asset, the candidate count, and the last error.
- `evolve-candidates` lists stored candidates with their id, asset, digest, and status. A fresh install has none; stored candidates stay listed after switching back to `observe`.
- `evolve-show` (`/evolve show <id>`) prints one candidate.
- `evolve-history` lists recent human actions.
- `evolve-cycle` generates and tests a candidate, in `propose` mode only.
- `evolve-approve` (`approve <id> <digest>`) applies a ready candidate, `evolve-reject` (`reject <id> <digest>`) discards it without changing what is applied, and `evolve-rollback` (`rollback <asset> <revision>`) restores an earlier revision.

## How to get to it (user POV)

- In the web UI, type `/evolve status` (or another verb) in the composer and choose `Send message`. The composer is `Describe what you want to build, / commands, @ files or sessions` in a new session and `Message or run a task, / commands, @ files or sessions` after the first turn.

## Driving it with dshv

Preconditions:

- A DSH checkout that the manifest accepts. `engines.dsh` is exactly `=0.2.1-rc.3`, and `dsh plugin add` refuses the package on any other version, so `dshv up plugins/dsh-evolve` exits 1 with `installation rejected: ... incompatible with dsh <version>` and starts nothing. On 2026-11-23 (DSH `0.2.2-rc.1`) this feature was unreachable for that reason.
- Once it installs, doctor shows `include:local-evolve` active. Doctor checks only rows of the installed package, so `include:preset-evolve-trial` (module `@deepseek-ai/dsh-agent-preset`) appears only if it fails.
- Add a workspace first (see [workspace-attach.md](./workspace-attach.md)); without one the composer is the `Choose workspace` textbox.

- **Status.** Run `dshv web "$RUN" fill --role textbox --name "Describe what you want to build" --value "/evolve status"`, then `dshv web "$RUN" click --role button --name "Send message"`. A JSON reply with `"mode": "observe"` and `"dailyRequestLimit": null` appears; capture it with `dshv web "$RUN" snapshot` and `dshv web "$RUN" screenshot evolve-commands/status.png`.
- **No model call.** `dshv logs "$RUN" mock.out` has no new `request` record after the command.
- **Candidates.** Send `/evolve candidates` the same way. On a fresh run the reply is an empty JSON list.

## Gotchas

- Not yet executed with `dshv`: the install is refused on the current checkout (see Preconditions).
- The bundle's default `locale` is `ja`. It changes the command description, the input hint, and error text, not the JSON of a successful reply.
- `propose` mode needs a fixed route, `dailyRequestLimit`, and at least one test per `evolve-` asset in a profile patch, and it calls the model. The cycle parses the model's proposal as strict JSON, so against the default mock (`mock response recovered`) it records `CYCLE_FAILED` and creates no candidate.
