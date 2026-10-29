# Historical packet formats

This file identifies legacy evidence formats preserved in the migrated store. They are not production command inputs and have no launcher in this skill.

Historical runs may contain `queue.json`, `fetch-packet.json`, `evidence.json`, `execution.json`, `classified.json`, `topic-intake.json`, publication receipts, and verification evidence. Their hashes, source paths, model attribution, decisions, and publication state remain immutable migration evidence. Do not edit them to fit the current schema or pass Jev distributions to a legacy single-classifier finalizer.

The production Go history views expose verified queue and decision occurrences, run state, publication receipts, and unregistered classified items without opening the legacy paths:

```sh
/data/references/AI/bin/aistore --store /data/references/AI --json history summary
/data/references/AI/bin/aistore --store /data/references/AI --json history run RUN_ID
/data/references/AI/bin/aistore --store /data/references/AI --json history reference IDENTITY
/data/references/AI/bin/aistore --store /data/references/AI --json history unregistered-classified
```

A historical `classified` decision is not proof of registration or publication. Only migrated receipt and verification evidence can mark a run published. Missing proof remains `unknown`; historical runs are not resumable. Use [topic-pipeline.md](topic-pipeline.md) for new intake.
