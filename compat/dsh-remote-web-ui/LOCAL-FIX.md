# Local compatibility fix: 0.4.4-local.2

Base: `@linxin666/dsh-remote-web-ui@0.4.4`, copied from the installed package on 2026-10-05. Package name, Apache-2.0 license, icon, display resources, exports, dependencies and Cordis patch are preserved. Preparing this artifact does not install it, restart the profile, or change pairing state.

## Limited changes

### Retired transport generations (local.1)

Each `installRemoteChannel` call owns one `active` flag. Restore retires that generation before restoring transports and is idempotent. Pending fetch completions check the flag after network completion and again after awaited denial JSON parsing, so an obsolete generation cannot show or hide a pairing notice. Captured fetch, WebSocket, EventSource and resource `src` setters cannot apply that generation's rewrite after retirement. Current-generation rewriting, device credential attachment and unpaired-403 callbacks retain their existing behavior. Already-sent requests are not cancelled.

The identical lifetime change is applied to [TypeScript source](<src/client/remote-channel.ts>), [unbundled JavaScript](<lib/types/client/remote-channel.js>) and [served client bundle](<lib/client.js>). Source files exist in the base and are included; this is not a dependency rebuild. The served bundle's stale `sourceMappingURL` trailer is removed; the original map resource is retained but is not advertised as a map of the patched bundle.

### Explicit bootstrap pairing policy (local.2)

The existing Host `webserver/index-inject` listener appends a non-secret global row named `__DSH_REMOTE_PAIRING_POLICY__` with the boolean value `enabled && requirePairingForLan` on every render, including false. It appends this row before the existing conditional remote-channel boot script. The true-policy boot script and its condition are unchanged. Client initialization reads that marker only when its value is a boolean; absent or invalid values retain the undefined, fail-closed provisional behavior. A false marker prevents provisional remote transport installation while the settings snapshot is loading. The normal public policy fetch, later settings updates, and `remoteChannelRequired` precedence remain unchanged.

This followup explicitly supersedes local.1's whole-Host byte-identical guarantee: [Host source](<src/index.ts>), [unbundled Host](<lib/types/index.js>) and [Host bundle](<lib/index.js>) contain only the added bootstrap-policy row. [Client source](<src/client/index.ts>), [unbundled Client](<lib/types/client/index.js>) and the served Client initialize the marker consistently. Host authentication, `/remote` gating, routing, pair tokens, device state and user settings are not modified. No overlay-hiding plugin is introduced.

Exactly nine original files differ from 0.4.4: the three channel files, three Host entry files, two additional Client entry files, and [package metadata](<package.json>). Metadata changes only the local version and distribution file list for provenance. All 197 other original files remain byte-identical, including all standalone server authentication/gating modules and the boot transport script. Relative to local.1, only the six Host/Client entry artifacts and package version change.

## SHA-256 and exact patch verification

The complete original 206-file inventory is in [base-sha256.json](<local-fix/base-sha256.json>); [local1-sha256.json](<local-fix/local1-sha256.json>) records local.1 at the same paths. Selected hashes:

| Artifact | SHA-256 |
| --- | --- |
| Original/local.1 Host bundle | `80429588cafa9a66e77aed397306a0519d42ccbb5c2890492b5c5a41dd59f67a` |
| Local.2 [Host bundle](<lib/index.js>) | `9eccea0e62d9e5773bffde53572d0837e372827741e1a2d4b5b33b3003b66e94` |
| Original [channel source](<src/client/remote-channel.ts>) | `625f24f4cab5183b122ff49bb14884fc90e85baa70c6ed68dbd1b1e27b065328` |
| Original [unbundled channel](<lib/types/client/remote-channel.js>) | `a1d4220441fa80a8164dc3cd185576e779c05fc6a6087b914b2cd792c9044752` |
| Original [served Client](<lib/client.js>) | `c39e0f90e61ba0343a79272b3fbabf7aaf608392d706e65dde290235793dbe63` |
| [Apache license](<LICENSE>) | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| [Icon](<icon.svg>) | `3d5a92cbc426a2d88b3e65e42c429db2cd21aeab8c5ce25711c8072001a93bcc` |

The [patch script](<local-fix/patch.mjs>) checks every original hash and each exact snippet's unique match before any write. Apply it only to a separate pristine workspace copy of 0.4.4, never to the installed profile. Verification reverses only the listed substitutions in memory and compares all 206 base hashes, proving the Host bundle differs only by the one injection statement and that no other authentication/gating logic changed.

```sh
node local-fix/patch.mjs --apply /absolute/path/to/pristine-workspace-copy
node local-fix/patch.mjs --verify
node --check lib/index.js
node --check lib/client.js
node --check lib/types/index.js
node --check lib/types/client/index.js
node --test --test-timeout=5000 --test-reporter=tap local-fix/bootstrap-policy.test.mjs local-fix/remote-channel.test.mjs
pnpm pack --pack-destination .
node local-fix/verify-package.mjs
```

## Offline regression evidence

The [lifetime tests](<local-fix/remote-channel.test.mjs>) run the same 11 cases against source with types stripped by Node's standard library, unbundled JavaScript, and the exact channel region extracted from the served bundle. Deferred promises explicitly place restoration during network or JSON waits; no sleeps or real network requests are used. The [0.4.4 run](<local-fix/base-tests.tap>) has 27 expected failures and 6 passes; the [local.1 run](<local-fix/fixed-tests.tap>) has 33 passes. An initial fixture omitted cloned-response `status`, causing readiness timeouts; it was corrected before recorded red/green runs. Exact source-map trailer matching was also corrected before successful patch application.

The [bootstrap-policy tests](<local-fix/bootstrap-policy.test.mjs>) execute the actual injection registration and Client channel initialization sections extracted from all three source/distribution forms. The Host hook is emitted repeatedly across every enabled/pairing boolean combination. Rows are rendered through DSH's actual `renderIndexInjections`, and the resulting scripts execute in a fresh Node VM to verify the boolean exists before both the true-policy boot-script test sentinel and a Client entry sentinel. Client cases cover false, true, missing, invalid string/null markers and both settings-precedence directions. Other Host/plugin initialization and full DOM/module-loader integration are outside these focused tests.

The renderer defaults to `/data/softwares/deepseek-harness-upgrade-master/packages/host/webserver/lib/types/injections.js`; override `DSH_INDEX_INJECTIONS` for another checkout. Its tested SHA-256 is `f84993e9642d46eec80eb35a834d7ee515d760bdeb24259462232a237073da2d`. No renderer copy or handwritten renderer is used. The [local.1 policy negative control](<local-fix/local1-policy-tests.tap>) has 15 expected failures, 9 passes and zero cancellations. The [combined local.2 run](<local-fix/local2-tests.tap>) has 57 passes, zero failures and zero cancellations, including the existing 33 lifetime tests.

Use `REMOTE_CHANNEL_PACKAGE=/absolute/path/to/earlier-package` to run negative controls. All tests use Node standard libraries and existing pure package JavaScript; no dependencies were installed and no model/network APIs, real device credentials, settings mutations, or pairing operations were used. These tests strip TypeScript but do not typecheck it. Parent-owned installation, restart decisions and live public-GUI verification are separate from artifact preparation.
