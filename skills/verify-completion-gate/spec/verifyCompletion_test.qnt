// verifyCompletion_test.qnt — scenario tests for the verification-before-completion model
//
// Each run chain drives the state machine through a documented scenario and
// asserts the resulting state. The nondeterministic outcomes (check pass/
// fail, evidence narrow/covering, confidence grade A/B/C, receipt L0/L1/L2,
// chosen stop) are parameters of the actions, so every scenario is
// deterministic and reproducible.
//
// The flow is Working → Check → Graded → Stopped, where Stopped carries one
// of four stop states (done | blocked | needs-verification | scope-exceeded).
// The `claim` action's guards encode the skill's rules: confidence C and
// narrower scope cannot reach done; complexity exceeded-unresolved and
// destructive-without-scoped-permission force blocked.

module verifyCompletionGateTest {
  import verifyCompletion(DESTRUCTIVE_NEEDED = false, BUGGY_CONF_C = false).* from "./verifyCompletion"

  // Full happy path: run a fresh covering check that passes → grade A →
  // choose L1 → claim done. Done is terminal and honest (no downgrade, no
  // complexity block, evidence covers the claim, confidence A).
  run happyPathTest =
    init
      .then(runCheck(true, false))
      .expect(phase == Check and checkRan and scope == CoversClaim and not(downgraded))
      .then(grade(A, L1))
      .expect(phase == Graded and confidence == A and receipt == L1)
      .then(claim(Done))
      .expect(phase == Stopped and stop == Done and claimed and not(downgraded))
      .expect(checkBeforeComplete)
      .expect(confidenceCNotDone)
      .expect(claimWithinCoverage)
      .then(claim(Done).fail())           // Stopped is terminal

  // Confidence A with covering evidence: the strongest claim — done is
  // allowed and reached. Receipt L0 fast-path for tiny low-risk work.
  run confidenceADoneTest =
    init
      .then(runCheck(true, false))
      .then(grade(A, L0))
      .then(claim(Done))
      .expect(stop == Done and confidence == A and receipt == L0)

  // Confidence B with covering evidence and bounded residual risk: done is
  // still allowed (B = direct target evidence with bounded residual risk).
  // Receipt L1 default.
  run confidenceBDoneTest =
    init
      .then(runCheck(true, false))
      .then(grade(B, L1))
      .then(claim(Done))
      .expect(stop == Done and confidence == B)

  // Confidence C (partial evidence only): the guard rejects done; the agent
  // asked for done but the honest stop is needs-verification. A downgrade
  // happened. This is the skill's core rule: "do not claim full completion."
  run confidenceCNotDoneTest =
    init
      .then(runCheck(true, false))
      .then(grade(C, L1))
      .then(claim(Done))
      .expect(stop == NeedsVerification and downgraded and confidence == C)

  // Evidence narrower than the claim: a claimed done is downgraded to
  // scope-exceeded. "Slice evidence cannot close the whole task."
  run narrowerScopeNotDoneTest =
    init
      .then(runCheck(true, true))
      .then(grade(A, L1))
      .then(claim(Done))
      .expect(stop == ScopeExceeded and downgraded and scope == Narrower)

  // A failing check (ok = false): the evidence is failing, so the downgrade
  // signal fires. The agent can still grade and claim a non-done stop.
  run failingCheckDowngradesTest =
    init
      .then(runCheck(false, false))
      .expect(downgraded and phase == Check)
      .then(grade(C, L1))
      .then(claim(NeedsVerification))
      .expect(stop == NeedsVerification and downgraded)

  // Complexity closure exceeded-unresolved: blocks completion. Even with
  // confidence A and covering evidence, a claimed done is forced to blocked.
  run complexityBlocksDoneTest =
    init
      .then(markComplexity)
      .expect(complexityExceeded)
      .then(runCheck(true, false))
      .then(grade(A, L1))
      .then(claim(Done))
      .expect(stop == Blocked and complexityExceeded)

  // Complexity resolved (retirement trigger added): clears the block, so a
  // claimed done with confidence A and covering evidence reaches done.
  run complexityResolvedDoneTest =
    init
      .then(markComplexity)
      .then(resolveComplexity)
      .expect(not(complexityExceeded))
      .then(runCheck(true, false))
      .then(grade(A, L1))
      .then(claim(Done))
      .expect(stop == Done and not(complexityExceeded))

  // Each receipt level is reachable at the Graded phase.
  run receiptL0Test =
    init
      .then(runCheck(true, false))
      .then(grade(A, L0))
      .expect(receipt == L0 and phase == Graded)

  run receiptL1Test =
    init
      .then(runCheck(true, false))
      .then(grade(B, L1))
      .expect(receipt == L1 and phase == Graded)

  run receiptL2Test =
    init
      .then(runCheck(true, false))
      .then(grade(A, L2))
      .expect(receipt == L2 and phase == Graded)

  // Each non-done stop state is reachable.
  run stopBlockedTest =
    init
      .then(markComplexity)
      .then(runCheck(true, false))
      .then(grade(A, L1))
      .then(claim(Done))
      .expect(stop == Blocked)

  run stopNeedsVerificationTest =
    init
      .then(runCheck(true, false))
      .then(grade(C, L1))
      .then(claim(NeedsVerification))
      .expect(stop == NeedsVerification)

  run stopScopeExceededTest =
    init
      .then(runCheck(true, true))
      .then(grade(A, L1))
      .then(claim(Done))
      .expect(stop == ScopeExceeded)

  // No claim before a fresh check: `claim` is blocked in the Working phase
  // (the guard requires phase == Graded, which only follows Check).
  // (`.fail()` must be the last step — see ISSUES.md issue 2.)
  run noClaimBeforeCheckTest =
    init
      .then(claim(Done).fail())

  // No grading before a check ran: `grade` is blocked in the Working phase.
  run noGradeBeforeCheckTest =
    init
      .then(grade(A, L1).fail())

  // A confidence-C work item that honestly selects needs-verification (not
  // done) is NOT a downgrade-by-guard — the agent chose the honest stop.
  run confidenceCHonestStopTest =
    init
      .then(runCheck(true, false))
      .then(grade(C, L1))
      .then(claim(NeedsVerification))
      .expect(stop == NeedsVerification and not(downgraded) and confidence == C)

  // --- Mizchi-style deterministic gate (counterexample→regression-test) ----
  // confidenceCNotDone says (stop == Done and claimed) implies confidence != C.
  // Random simulation reports "No violation" on the fixed model, but that is
  // probabilistic — it can miss the violating trace. mizchi's move: lock the
  // exact dangerous trace as a deterministic test, so the gate becomes "this
  // trace does not violate" (reproducible), not "the sampler found nothing".
  //
  // The dangerous trace: a fresh covering check passes → grade confidence C →
  // claim done. On the fixed model the confidence-C guard routes done to
  // needs-verification, so the cap holds and this test PASSES. On the
  // vulnerable variant (BUGGY_CONF_C = true) the guard is gone, done is
  // honored at confidence C, and this test FAILS — the gate catches the
  // regression. The matching counterexample proof lives in
  // verifyCompletionVulnerableTest::confidenceCCounterexample.
  run confidenceCSentinelTest =
    init
      .then(runCheck(true, false))
      .then(grade(C, L1))
      .then(claim(Done))
      .expect(confidenceCNotDone)          // the gate: the cap holds on this trace
      .expect(stop != Done)               // confidence C routed away from done
}

module verifyCompletionDestructiveTest {
  import verifyCompletion(DESTRUCTIVE_NEEDED = true, BUGGY_CONF_C = false).* from "./verifyCompletion"

  // Destructive work without scoped permission: a claimed done is forced to
  // blocked. "Warnings or broad assent do not grant it."
  run destructiveNoPermissionBlockedTest =
    init
      .then(runCheck(true, false))
      .then(grade(A, L1))
      .then(claim(Done))
      .expect(stop == Blocked and not(scopedPermission))

  // Granting scoped permission unblocks completion: after the authority grants
  // scoped permission, a claimed done with confidence A and covering evidence
  // reaches done.
  run destructivePermissionUnblocksTest =
    init
      .then(grantScopedPermission)
      .expect(scopedPermission)
      .then(runCheck(true, false))
      .then(grade(A, L1))
      .then(claim(Done))
      .expect(stop == Done and scopedPermission)
}

// Vulnerable variant (BUGGY_CONF_C = true): the confidence-C guard is gone,
// so a confidence-C work item can reach done, violating confidenceCNotDone.
// This module holds the counterexample proof — the exact trace that reaches
// the violation. It PASSES here (the violation is reached, as expected) and is
// the artifact kept to document/lock the dangerous condition. The fixed
// model's gate is confidenceCSentinel in verifyCompletionGateTest, which
// runs the same trace and asserts confidenceCNotDone holds.
module verifyCompletionVulnerableTest {
  import verifyCompletion(DESTRUCTIVE_NEEDED = false, BUGGY_CONF_C = true).* from "./verifyCompletion"

  // Counterexample: a fresh covering check passes → grade confidence C →
  // claim done. With the confidence-C guard removed, done is honored at
  // confidence C, so confidenceCNotDone ((stop == Done and claimed) implies
  // confidence != C) is false and .expect(not(confidenceCNotDone)) holds —
  // the violation is reproduced deterministically, not by chance sampling.
  run confidenceCCounterexampleTest =
    init
      .then(runCheck(true, false))
      .then(grade(C, L1))
      .then(claim(Done))
      .expect(stop == Done and confidence == C)   // the hole: done at confidence C
      .expect(not(confidenceCNotDone))            // the violation is reached
}