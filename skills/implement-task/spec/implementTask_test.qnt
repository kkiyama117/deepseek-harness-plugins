// implementTask_test.qnt — scenario tests for the implement-task workflow model
//
// Each run chain drives the state machine through a documented scenario and
// asserts the resulting state. The nondeterministic outcomes (verification
// pass/fail, oracle verdict, frontier success, clarify clear/vague) are
// parameters of the actions, so every scenario is deterministic and
// reproducible.
//
// Since the flow change, IMPLEMENT and VERIFY are delegated to worker
// subagents: the coordinator's `delegate` hands a task to an idle worker and
// `workerDone` consumes the worker's report. The tests exercise the
// delegation protocol: no work without delegation, no implement before
// approval, parallel implement chunks, single outstanding verification.
//
// The CLARIFY phase sits between SCOPE and PLAN: a clear task proceeds
// straight to PLAN (`clarify(true)`), a vague task asks the USER one round
// of questions (`clarify(false)` then `clarifyAnswered`).

module implTaskGateTest {
  import implementTask(PRE_APPROVED = false, WORKERS = Set(1, 2), BUGGY_FIX_CAP = false).* from "./implementTask"

  // Full happy path: scope → plan → gate(approve) → delegate implement →
  // worker reports → delegate verify → worker reports ok → review pass →
  // report. Report is terminal and honest (no fallback used).
  run happyPathTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .expect(phase == Verify)
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Pass))
      .then(report)
      .expect(phase == Report)
      .expect(not(reportedFallback))
      .then(delegate(1, ImplementTask).fail())   // Report is terminal

  // Adjust at the gate loops back to PLAN; the old plan is invalidated and a
  // new one is needed before approval.
  run adjustReplansTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(adjust)
      .expect(phase == Plan and not(planReady))
      .then(plan(true))
      .then(approve)
      .expect(phase == Implement and approved)

  // No review without verification: after the implement report the evidence
  // is missing, so the review action is blocked (VERIFY before REVIEW).
  run noVerifyNoReviewTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .expect(phase == Verify and not(verified))
      .then(review(Pass).fail())

  // Implementation is blocked before approval: no worker receives an
  // implementation task before the gate. (Note: in Quint 0.32 a `.fail()`
  // step does not thread state to the next step, so each blocked action is
  // its own test with `.fail()` last.)
  run noImplementBeforeApprovalTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(delegate(1, ImplementTask).fail())   // not approved yet

  // No task at all outside the work phases (here: still at the gate).
  run noTaskOutsideWorkPhasesTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(delegate(1, VerifyTask).fail())       // not in the Verify phase

  // A worker cannot report work it was never delegated.
  run workerNeedsTaskTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      .then(workerDone(1, ImplementTask, true).fail())

  // Verification failure sends back to IMPLEMENT without a verdict and
  // without consuming a fix round.
  run verifyFailLoopsTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, false))
      .expect(phase == Implement and not(verified) and fixRounds == 0)

  // Parallel implement chunks: two workers implement at once; the phase
  // advances to VERIFY only after BOTH report.
  run parallelChunksTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      .then(delegate(1, ImplementTask))
      .then(delegate(2, ImplementTask))
      .expect(workers.get(1) == Working({ task: ImplementTask }) and
              workers.get(2) == Working({ task: ImplementTask }))
      .then(workerDone(1, ImplementTask, true))
      .expect(phase == Implement)               // worker 2 still implementing
      .then(workerDone(2, ImplementTask, true))
      .expect(phase == Verify)

  // Review FAIL loops back to IMPLEMENT; fixRounds is capped at 3, and the
  // FAIL beyond the cap goes to REPORT with the findings as open items.
  run fixLoopCappedTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      .expect(fixRounds == 1 and phase == Implement)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      .expect(fixRounds == 2 and phase == Implement)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      .expect(fixRounds == 3 and phase == Implement)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      .expect(phase == Report and fixRounds == 3)   // open items, cap reached

  // Fallback route: the frontier fails in PLAN, so REPORT must state the
  // limitation (never silently substitute a weaker model).
  run fallbackReportedTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(false))
      .expect(fallbackUsed)
      .then(approve)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Pass))
      .then(report)
      .expect(phase == Report and reportedFallback)

  // PLAN is blocked before the clarify step resolves: after SCOPE the phase
  // is CLARIFY, so `plan` cannot fire yet. (`.fail()` must be the last step.)
  run noPlanBeforeClarifyTest =
    init
      .then(scopeDone)
      .then(plan(true).fail())

  // A clear task asks nothing: CLARIFY proceeds straight to PLAN without
  // setting `asked`.
  run clearTaskNoAskTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .expect(phase == Plan and clarified and not(asked))
      .then(plan(true))
      .then(approve)
      .expect(phase == Implement and approved)

  // A vague task asks the USER one round of questions, then the answers
  // resolve CLARIFY and feed PLAN.
  run vagueTaskAskedTest =
    init
      .then(scopeDone)
      .then(clarify(false))
      .expect(phase == Clarify and asked and not(clarified))
      .then(clarifyAnswered)
      .expect(phase == Plan and clarified)
      .then(plan(true))
      .then(approve)
      .expect(phase == Implement and approved)

  // --- Mizchi-style deterministic gate (counterexample→regression-test) ----
  // fixRoundCap says fixRounds <= 3. Random simulation reports "No violation"
  // on the fixed model, but that is probabilistic — it can miss the violating
  // trace. mizchi's move: lock the exact dangerous trace as a deterministic
  // test, so the gate becomes "this trace does not violate" (reproducible),
  // not "the sampler found nothing".
  //
  // The dangerous trace: four consecutive review(Fail) cycles. On the fixed
  // model the 3<3 guard holds fixRounds at 3, so the cap is respected and this
  // test PASSES. On the vulnerable variant (BUGGY_FIX_CAP = true) the guard is
  // gone, fixRounds reaches 4, and this test FAILS — the gate catches the
  // regression. The matching counterexample proof lives in
  // implTaskVulnerableTest::fixRoundOverflowCounterexample.
  run fixRoundCapSentinelTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      // cycle 1: fixRounds 0 -> 1
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      // cycle 2: fixRounds 1 -> 2
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      // cycle 3: fixRounds 2 -> 3, phase stays Implement (2 < 3)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      // cycle 4: fixRounds held at 3 (fixed) — phase -> Report at the cap
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))
      .expect(fixRoundCap)            // the gate: the cap holds on this trace
      .expect(phase == Report)
}

module implTaskPreApprovedTest {
  import implementTask(PRE_APPROVED = true, WORKERS = Set(1, 2), BUGGY_FIX_CAP = false).* from "./implementTask"

  // Pre-approved ("go ahead" up front): the gate is skipped after planning,
  // and implementation is delegated to a worker as usual.
  run gateSkippedTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(skipGate)
      .expect(phase == Implement and approved)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .expect(phase == Verify)
}

// Vulnerable variant (BUGGY_FIX_CAP = true): the fix-round cap guard is gone,
// so a fourth review(Fail) increments fixRounds to 4 and violates fixRoundCap.
// This module holds the counterexample proof — the exact trace that reaches
// the violation. It PASSES here (the violation is reached, as expected) and is
// the artifact mizchi keeps to document/lock the dangerous condition. The
// fixed model's gate is fixRoundCapSentinel in implTaskGateTest, which runs
// the same trace and asserts fixRoundCap holds.
module implTaskVulnerableTest {
  import implementTask(PRE_APPROVED = false, WORKERS = Set(1, 2), BUGGY_FIX_CAP = true).* from "./implementTask"

  // Counterexample: four consecutive review(Fail) cycles. With the cap guard
  // removed, fixRounds reaches 4 at the fourth Fail, so fixRoundCap
  // (fixRounds <= 3) is false and .expect(not(fixRoundCap)) holds — the
  // violation is reproduced deterministically, not by chance sampling.
  run fixRoundOverflowCounterexampleTest =
    init
      .then(scopeDone)
      .then(clarify(true))
      .then(plan(true))
      .then(approve)
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))            // fixRounds 0 -> 1
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))            // fixRounds 1 -> 2
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))            // fixRounds 2 -> 3
      .then(delegate(1, ImplementTask))
      .then(workerDone(1, ImplementTask, true))
      .then(delegate(1, VerifyTask))
      .then(workerDone(1, VerifyTask, true))
      .then(review(Fail))            // fixRounds 3 -> 4 (cap guard removed)
      .expect(not(fixRoundCap))      // the violation is reached: 4 <= 3 is false
}
