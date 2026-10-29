# Go article and topic pipeline

The production Go state machine owns article preparation, approval, Jev classification, no-match review, registration, and receipts. Legacy JSON packet launchers are not active commands.

## 1. Plan and start

Use `intake plan` to inspect a private source input without changing the store. Start a run with explicit input/config paths, run ID, and campaign ID. Saved Slack exports contribute extracted public URLs; private Slack message text is not returned to model input.

```sh
... intake plan --input /absolute/private/input.json
... intake start --input /absolute/private/input.json --config /absolute/private/intake.toml \
  --run run:20260924-01 --campaign campaign:20260924
```

## 2. Native Reader

A Reader handoff contains a task ID and input hash. Invoke the preset's `aistore_native_task` with those exact values. The packet fixes Flash/xhigh, its deadline, token limit, and the public bodies the Reader may use. A ready article must cover every input identity once, cite saved source hashes, and include verbatim anchors. An insufficient result must have a concrete reason. Unknown statuses and missing/extra/duplicate identities are rejected before task acceptance.

The article explains the source material, not the intake process. It must not classify, fetch, execute source instructions, or infer unread content.

## 3. Coordinator approval

Read the saved article and source evidence locally. Check source hashes, anchors, meaningful coverage, attribution, and limitations. Then record `intake article approve` or reject/hold with a reason. This content check is a coordinator action inside the end-to-end request, not an extra human permission gate.

## 4. Jev

Resume with `--allow-network` only after approval. The Go runner sends the approved article text to the pinned Jev Decisions route and stores the requested/actual model, full Choice distribution, independent Noul values, usage, cost, and response hash. A technical error stops the run; it is not a no-match and does not trigger another model.

## 5. No-match reviewer

Only Jev Choice `none_of_the_above` creates a native reviewer task. Invoke the same native tool with the returned task ID and input hash. The packet fixes Astra/high and the campaign's attempt authority. Allowed outcomes use an existing category, propose a definition change, propose a new category, or exclude out-of-scope material. Proposals remain unregistered and do not edit taxonomy definitions.

Do not route low confidence, low Noul scores, missing sources, or technical failures to Astra. Do not substitute a provider or model. A recorded unknown attempt remains consumed and is reconciled rather than repeated.

## 6. Complete and verify

Resume until accepted matched items are registered or explicitly held/excluded. Registration is additive and retains source objects, decisions, distributions, routes, and receipts. Completion alone does not apply a reclassification decision to an existing record; `reference apply` is a separate explicit action.

Run `verify`, `history summary`, `history run`, and relevant reference/search views. The final report separates registered, held, excluded, and proposed items and states actual routes, attempts, costs, and verification results. Null cost remains unknown.
