#!/usr/bin/env bash
# Run /kstack:maintain-verification-skill on verify-dsh-plugins, unattended,
# in a throwaway worktree of origin/main so the operator's checkout is never touched.
# Usage: bin/weekly-verify-maintenance.sh   (the weekly systemd timer calls this)
# Writes report.md, claude.err, and outcome.txt to $DSHV_EVIDENCE_ROOT/maintain-<stamp>/.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SKILL=.claude/skills/verify-dsh-plugins
STAMP=$(date +%Y%m%d-%H%M%S)
export DSHV_EVIDENCE_ROOT=${DSHV_EVIDENCE_ROOT:-$REPO/reports/verify-dsh-plugins}
LOG=$DSHV_EVIDENCE_ROOT/maintain-$STAMP
WT=${TMPDIR:-/tmp}/verify-maintain-$STAMP
mkdir -p "$LOG"

git -C "$REPO" fetch --quiet origin main
git -C "$REPO" worktree add --quiet --detach "$WT" origin/main
# Commits the run made stay on their branch; only the directory goes.
trap 'git -C "$REPO" worktree remove --force "$WT"' EXIT

if [ ! -d "$WT/$SKILL" ]; then
  echo "skipped: $SKILL is not on origin/main" | tee "$LOG/outcome.txt"
  exit 0
fi
# Machine settings are git-ignored, so carry them over, or fall back to the
# DSH checkout next to the main repository (the worktree has no such sibling).
if [ -f "$REPO/$SKILL/.env" ]; then
  cp "$REPO/$SKILL/.env" "$WT/$SKILL/.env"
else
  export DSHV_DSH_ROOT=${DSHV_DSH_ROOT:-$REPO/../deepseek-harness}
fi

cd "$WT"
status=0
claude -p --permission-mode auto \
  "/kstack:maintain-verification-skill Target: $SKILL. This is the scheduled weekly pass, run unattended: do not ask questions. Base any PR on main and put the outcome (clean, changed, or blocked) on the first line of your reply." \
  > "$LOG/report.md" 2> "$LOG/claude.err" || status=$?
head -n 1 "$LOG/report.md" > "$LOG/outcome.txt"
echo "exit $status" >> "$LOG/outcome.txt"
cat "$LOG/outcome.txt"
exit "$status"
