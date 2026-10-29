#!/usr/bin/env bash
# verify-baseline.sh — implement-task spec baseline gate.
#
# Runs `quint` and `node` from PATH. In CI, the workflow installs quint via npm
# and sets up node. In the DSH sandbox, run this inside the quint container
# (which has both on PATH) — that is a faithful CI simulation:
#   container_exec (podman, localhost/claudecode:latest, entrypoint /bin/sh -c):
#     bash /work/skills/implement-task/spec/verify-baseline.sh
#
# Baseline = three checks, all must pass:
#   1. quint-verify  — every invariant SATISFIED (safety) + every witness REACHED
#      (liveness), emitted as a structured report.
#   2. scenario tests — the spec's own run tests (happy path, fix-loop cap,
#      parallel chunks, fallback, the proto-1 sentinel, and the proto-1
#      counterexample lock on the vulnerable variant).
#   3. replay-gate self-tests — regenerate replayTrace.{good,bad}.qnt from
#      trace.{good,bad}.json via replay.mjs, then assert the good trace passes
#      the gate (exit 0) and the bad trace fails it (exit non-zero).
#
# Exit 0 = baseline pass, non-zero = fail. set -euo pipefail makes the first
# failing check stop the gate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"   # skills/implement-task/spec -> repo root
SPEC="$REPO_ROOT/skills/implement-task/spec"
VERIFY="$REPO_ROOT/skills/quint-verify/verify.mjs"
REPORT="$SPEC/.baseline-verify-report.json"

INV="fixRoundCap planRequiresClarify reviewOnlyAfterVerify reportRequiresReview noImplementBeforeApproval approveRequiresPlan reportHonesty workHappensInWorkers"
WIT="reachedClarify clarifyUsed reachedImplement reachedVerify reachedReview reachedReport fixLoopUsed capReachedOpenItems fallbackOccurred delegationUsed parallelChunks"

echo "=================================================================="
echo "implement-task spec baseline  (quint from PATH: $(command -v quint || echo MISSING))"
echo "=================================================================="

echo "── 1. quint-verify: invariants (safety) + witnesses (liveness) ──"
node "$VERIFY" "$SPEC/implementTask.qnt" implTaskGate \
  --invariants $INV --witnesses $WIT \
  --max-steps 40 --max-samples 1000 \
  --out "$REPORT"

echo "── 2. scenario tests: implTaskGateTest (14) ──"
quint test "$SPEC/implementTask_test.qnt" --main=implTaskGateTest

echo "── 2b. scenario tests: implTaskPreApprovedTest (1) ──"
quint test "$SPEC/implementTask_test.qnt" --main=implTaskPreApprovedTest

echo "── 2c. counterexample lock: implTaskVulnerableTest (proto-1) ──"
quint test "$SPEC/implementTask_test.qnt" --main=implTaskVulnerableTest

echo "── 3. replay-gate self-tests (proto-2): regenerate + good->pass, bad->fail ──"
REPLAY_DIR="$SPEC/replay"
node "$REPLAY_DIR/replay.mjs" "$REPLAY_DIR/trace.good.json" > "$REPLAY_DIR/replayTrace.good.qnt"
quint test "$REPLAY_DIR/replayTrace.good.qnt" --main=replayTrace

node "$REPLAY_DIR/replay.mjs" "$REPLAY_DIR/trace.bad.json" > "$REPLAY_DIR/replayTrace.bad.qnt"
if quint test "$REPLAY_DIR/replayTrace.bad.qnt" --main=replayTrace; then
  echo "ERROR: bad trace unexpectedly passed the replay gate (expected RED)" >&2
  exit 1
fi
echo "  (bad trace correctly failed the replay gate — expected RED)"

echo "=================================================================="
echo "BASELINE PASS  (report: $REPORT)"
echo "=================================================================="