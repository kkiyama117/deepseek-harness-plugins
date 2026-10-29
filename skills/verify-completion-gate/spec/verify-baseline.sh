#!/usr/bin/env bash
# verify-baseline.sh — verify-completion-gate spec baseline gate.
#
# Mirrors skills/implement-task/spec/verify-baseline.sh. Runs `quint` and
# `node` from PATH. In CI, the workflow installs quint via npm and sets up
# node. In the DSH sandbox, run inside the quint container (CI simulation):
#   container_exec (podman, localhost/claudecode:latest, entrypoint /bin/sh -c):
#     bash /work/skills/verify-completion-gate/spec/verify-baseline.sh
#
# Baseline = quint-verify (6 invariants SATISFIED + 16 witnesses REACHED) +
# scenario tests on all three test modules (gate 18, destructive 2, and the
# proto-1 counterexample lock on the vulnerable variant 1).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"   # skills/verify-completion-gate/spec -> repo root
SPEC="$REPO_ROOT/skills/verify-completion-gate/spec"
VERIFY="$REPO_ROOT/skills/quint-verify/verify.mjs"
REPORT="$SPEC/.baseline-verify-report.json"

INV="checkBeforeComplete confidenceCNotDone claimWithinCoverage complexityBlocksDone destructiveNeedsScopedPermission claimOnlyAfterGraded"
WIT="reachedCheck reachedGraded reachedStopped checkRanWitness confidenceAReached confidenceBReached confidenceCReached receiptL0Reached receiptL1Reached receiptL2Reached stopDoneReached stopBlockedReached stopNeedsVerificationReached stopScopeExceededReached downgradeHappened complexityBlockedHappened"

echo "=================================================================="
echo "verify-completion-gate spec baseline  (quint from PATH: $(command -v quint || echo MISSING))"
echo "=================================================================="

echo "── 1. quint-verify: invariants (safety) + witnesses (liveness) ──"
node "$VERIFY" "$SPEC/verifyCompletion.qnt" verifyCompletionGate \
  --invariants $INV --witnesses $WIT \
  --max-steps 40 --max-samples 1000 \
  --out "$REPORT"

echo "── 2. scenario tests: verifyCompletionGateTest (18) ──"
quint test "$SPEC/verifyCompletion_test.qnt" --main=verifyCompletionGateTest

echo "── 2b. scenario tests: verifyCompletionDestructiveTest (2) ──"
quint test "$SPEC/verifyCompletion_test.qnt" --main=verifyCompletionDestructiveTest

echo "── 2c. counterexample lock: verifyCompletionVulnerableTest (proto-1) ──"
quint test "$SPEC/verifyCompletion_test.qnt" --main=verifyCompletionVulnerableTest

echo "=================================================================="
echo "BASELINE PASS  (report: $REPORT)"
echo "=================================================================="