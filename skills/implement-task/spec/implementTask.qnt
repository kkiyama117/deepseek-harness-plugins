// implementTask.qnt — formal model of the implement-task skill workflow
//
// The skill (SKILL.md) is a 9-step flow: SCOPE → CLARIFY → PLAN → GATE →
// IMPLEMENT → VERIFY → REVIEW → ITERATE → REPORT, orchestrated by one
// coordinator agent.
// This model captures the flow as an executable phase state machine: the
// steps become phases, the rules become guarded transitions and invariants,
// and each phase/path has a reachability witness.
//
// Two actors own the flow (the "divide" of SKILL.md):
//   USER        — the human client: hands the task in, owns the gate
//                 decision (approve / adjust / skipGate), receives the
//                 REPORT. The USER is external to the state machine: its
//                 choices are the gate actions, never phase steps.
//   COORDINATOR — the manager / top gate of this flow: runs the phase
//                 machine and delegates to workers; the USER's single
//                 interface into the subagent pool.
//
// IMPLEMENT and VERIFY are NOT performed by the coordinator: they are
// delegated to worker subagents. The coordinator only delegates tasks
// (action `delegate`) and consumes worker reports (action `workerDone`);
// the phase advances and `verified` is set only through a worker's report.
// The `workers` map is the shared coordination state: a worker holds a task
// iff the coordinator delegated it. The worker's work+report is fused with
// the coordinator's consumption into one atomic action — the intermediate
// states (worker working, report in flight) are not observable to any
// invariant here, so the fusion is faithful at this abstraction level.
//
// ITERATE is not a phase: it is the transition Review(FAIL) → Implement,
// guarded by the fix-round cap (3). The frontier model and the USER are
// external: frontier calls are judgment-role actions in PLAN and REVIEW,
// USER choices are the approve/adjust/skip gate actions.
//
// See spec/README.md for the coverage map (requirement → model), what is
// deliberately not modeled, and how to run this spec.

module implementTask {
  // --- Types ------------------------------------------------------------
  // The 9 steps of the flow, as phases.
  type Phase = Scope | Clarify | Plan | Gate | Implement | Verify | Review | Report

  // Frontier oracle verdicts (references/reviewer-schema.json: PASS | FAIL).
  type Verdict = Pass | Fail

  // Work the coordinator delegates to worker subagents.
  type Task = ImplementTask | VerifyTask

  type WorkerId = int

  // A worker's local state: idle, or working on the delegated task.
  // (A sum type instead of `Option` — Option/Some/None live in the bundled
  // basicSpells stdlib, not in Quint core; this keeps the spec dependency-free.)
  type WorkerState = Idle | Working({ task: Task })

  // --- Constants ----------------------------------------------------------
  // True when the user said "go ahead" up front, so the gate is skipped
  // (SKILL.md step 3: "If the user already said 'go ahead', skip the gate").
  const PRE_APPROVED: bool

  // The worker subagents the coordinator can delegate to.
  const WORKERS: Set[WorkerId]

  // Experiment toggle for mizchi's counterexample→regression-test loop
  // (see spec/README.md "Mizchi-style gate"). When true, the fix-round cap
  // guard is removed from `review` (a FAIL always increments fixRounds), so a
  // fourth FAIL reaches fixRounds == 4 and violates fixRoundCap. The two
  // production instances pass BUGGY_FIX_CAP = false; only implTaskVulnerable
  // passes true. Remove this const once the loop pattern is established.
  const BUGGY_FIX_CAP: bool

  pure val BOOLS: Set[bool] = Set(false, true)
  pure val VERDICTS: Set[Verdict] = Set(Pass, Fail)
  pure val TASKS: Set[Task] = Set(ImplementTask, VerifyTask)

  // --- State --------------------------------------------------------------
  var phase: Phase
  var fixRounds: int          // review → fix cycles used; cap = 3 (step 7)
  var approved: bool          // plan approved at the gate, or gate skipped
  var planReady: bool         // frontier planner returned a validated plan (step 3)
  var clarified: bool         // the clarify step resolved (clear or answered) (step 2)
  var asked: bool             // clarifying questions were sent to the USER (step 2)
  var verified: bool          // deterministic verification evidence exists (step 5)
  var reviewed: bool          // frontier oracle returned a verdict (step 6)
  var fallbackUsed: bool      // frontier route failed → weaker model in a judgment role
  var reportedFallback: bool  // REPORT states the fallback limitation (step 8)
  var reported: bool          // the REPORT summary has been written (step 8)
  var workers: WorkerId -> WorkerState  // delegated tasks; None = idle

  // --- Init ----------------------------------------------------------------
  action init: bool = all {
    phase' = Scope,
    fixRounds' = 0,
    approved' = false,
    planReady' = false,
    clarified' = false,
    asked' = false,
    verified' = false,
    reviewed' = false,
    fallbackUsed' = false,
    reportedFallback' = false,
    reported' = false,
    workers' = WORKERS.mapBy(_ => Idle),
  }

  // --- Actions (one per phase transition) ----------------------------------
  // Every action assigns every variable (x' = x to leave unchanged): the
  // branches of `step`'s `any { }` must share one effect.
  //
  // 1. SCOPE — read the task and the code it touches, trace the real flow,
  //    state the completion condition.
  action scopeDone: bool = all {
    phase == Scope,
    phase' = Clarify,
    fixRounds' = fixRounds,
    approved' = approved,
    planReady' = planReady,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  // 2. CLARIFY — the COORDINATOR checks the scoped task for vagueness along
  //    the pi-clarify dimensions (ambiguous referents, unclear outcomes,
  //    undefined scope, missing constraints, or material ambiguity inspection
  //    cannot answer). If clear, proceed to PLAN. If vague, ask the USER one
  //    concise round of clarifying questions via `ask_user_question`; the
  //    answers feed PLAN. The vague path = questions sent to the USER
  //    (external), `asked` marks it; see ISSUES.md issue 1 — no `or` with a
  //    possibly-false left operand.
  action clarify(clear: bool): bool = all {
    phase == Clarify,
    phase' = if (clear) Plan else Clarify,
    clarified' = if (clear) true else clarified,
    asked' = if (clear) asked else true,
    fixRounds' = fixRounds,
    approved' = approved,
    planReady' = planReady,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  // 2'. The USER answers the clarifying questions; the answers feed PLAN.
  action clarifyAnswered: bool = all {
    phase == Clarify,
    asked,
    phase' = Plan,
    clarified' = true,
    asked' = asked,
    fixRounds' = fixRounds,
    approved' = approved,
    planReady' = planReady,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  // 3. PLAN — the FRONTIER planner (judgment role only) returns a validated
  //    plan. frontierOk = false models the documented fallback route
  //    (kimi-coding → cursor → plain subagent): the limitation must be
  //    reported in REPORT, never silently substituted.
  //    NOTE: written as `if (frontierOk) fallbackUsed else true` instead of
  //    `fallbackUsed or not(frontierOk)` — the Quint 0.32 Rust backend
  //    mis-evaluates `false or X` as false (simulation bug), so the spec
  //    avoids `or` with a possibly-false left operand. Use
  //    `--backend=typescript` for runs on that version.
  action plan(frontierOk: bool): bool = all {
    phase == Plan,
    planReady' = true,
    fallbackUsed' = if (frontierOk) fallbackUsed else true,
    phase' = Gate,
    fixRounds' = fixRounds,
    approved' = approved,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    reviewed' = reviewed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  // 3. GATE — the COORDINATOR presents the plan; the USER approves or adjusts.
  action approve: bool = all {
    phase == Gate,
    planReady,                // the gate presents a validated plan
    approved' = true,
    phase' = Implement,
    fixRounds' = fixRounds,
    planReady' = planReady,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  action adjust: bool = all {
    phase == Gate,
    planReady' = false,       // adjustments invalidate the plan → re-plan
    phase' = Plan,
    fixRounds' = fixRounds,
    approved' = approved,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  // 3'. GATE skipped when the USER already said "go ahead".
  action skipGate: bool = all {
    phase == Gate,
    PRE_APPROVED,
    planReady,
    approved' = true,
    phase' = Implement,
    fixRounds' = fixRounds,
    planReady' = planReady,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  // 4. IMPLEMENT — the coordinator delegates an implementation task to an
  //    idle worker; only after approval. The coordinator never implements
  //    itself: the only way out of IMPLEMENT is a worker's report.
  //    Implement chunks may run in parallel (SKILL.md step 4: "delegate
  //    parallelizable chunks"); verification is a single deterministic
  //    check, so at most one VerifyTask is outstanding at a time.
  //    Guard written as if/else instead of `or` — see the note on plan().
  action delegate(w: WorkerId, task: Task): bool = all {
    workers.get(w) == Idle,               // the worker must be idle
    if (task == ImplementTask)
      (phase == Implement and approved)
    else
      (phase == Verify and
        workers.keys().forall(x => workers.get(x) != Working({ task: VerifyTask }))),
    workers' = workers.set(w, Working({ task: task })),
    phase' = phase,
    fixRounds' = fixRounds,
    approved' = approved,
    planReady' = planReady,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
  }

  // 4+5. The worker reports: it must hold the task it reports on. An
  //    implementation report advances to VERIFY once no other worker is
  //    still implementing (parallel chunks); a verification report sets
  //    `verified` and advances to REVIEW (ok) or back to IMPLEMENT (not ok,
  //    a correction, not a review finding — no fix round consumed).
  action workerDone(w: WorkerId, task: Task, ok: bool): bool = all {
    workers.get(w) == Working({ task: task }),  // only a delegated worker reports
    workers' = workers.set(w, Idle),
    phase' = if (task == ImplementTask)
               if (workers.keys().exclude(Set(w))
                     .forall(x => workers.get(x) != Working({ task: ImplementTask })))
                 Verify                    // all implement chunks are in
               else
                 Implement
             else
               if (ok) Review else Implement,
    verified' = if (task == VerifyTask) ok else verified,
    fixRounds' = fixRounds,
    approved' = approved,
    planReady' = planReady,
    clarified' = clarified,
    asked' = asked,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
  }

  // 6+7. REVIEW / ITERATE — the FRONTIER oracle (judgment role only) returns
  //    a verdict. PASS → REPORT. FAIL → back to IMPLEMENT while fixRounds < 3;
  //    at the cap, report the remaining findings as open items.
  action review(v: Verdict): bool = all {
    phase == Review,
    verified,                 // VERIFY before REVIEW: missing evidence is FAIL
    reviewed' = true,
    // nested ifs instead of `v == Pass or fixRounds >= 3` — see the `or`
    // simulation bug note on plan()
    phase' = if (v == Pass) Report else if (fixRounds >= 3) Report else Implement,
    fixRounds' = if (v == Fail and (BUGGY_FIX_CAP or fixRounds < 3)) fixRounds + 1 else fixRounds,
    approved' = approved,
    planReady' = planReady,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    fallbackUsed' = fallbackUsed,
    reportedFallback' = reportedFallback,
    reported' = reported,
    workers' = workers,
  }

  // 8. REPORT — final summary (files, evidence, verdict, open items)
  //    delivered to the USER. Must state the fallback limitation honestly.
  action report: bool = all {
    phase == Report,
    not(reported),            // the summary is written once
    reported' = true,
    reportedFallback' = fallbackUsed,
    fixRounds' = fixRounds,
    approved' = approved,
    planReady' = planReady,
    clarified' = clarified,
    asked' = asked,
    verified' = verified,
    reviewed' = reviewed,
    fallbackUsed' = fallbackUsed,
    workers' = workers,
    phase' = phase,
  }

  action step: bool = {
    nondet ok = BOOLS.oneOf()
    nondet v = VERDICTS.oneOf()
    nondet fok = BOOLS.oneOf()
    nondet clear = BOOLS.oneOf()
    nondet w = WORKERS.oneOf()
    nondet task = TASKS.oneOf()
    any {
      scopeDone,
      clarify(clear),
      clarifyAnswered,
      plan(fok),
      approve,
      adjust,
      skipGate,
      delegate(w, task),
      workerDone(w, task, ok),
      review(v),
      report,
    }
  }

  // --- Invariants (the skill's rules, checkable) -----------------------------
  // Step 7: cap at 3 fix rounds.
  val fixRoundCap: bool = fixRounds <= 3
  // Steps 2 → 3: PLAN only after the clarify step resolved.
  val planRequiresClarify: bool = phase == Plan implies clarified
  // Steps 5 → 6: REVIEW only after VERIFY — while in the review phase,
  // verification evidence exists (the review action requires it; a FAIL
  // round's later re-verification may clear it, so the invariant is about
  // the review phase, not about any verdict ever produced).
  val reviewOnlyAfterVerify: bool = phase == Review implies verified
  // Steps 6 → 8: a report exists only after an oracle verdict.
  val reportRequiresReview: bool = phase == Report implies reviewed
  // Steps 3 → 4: no implementation before approval — no worker receives an
  // implementation task before the gate (or skip) approved the plan.
  val noImplementBeforeApproval: bool =
    not(approved) implies
      workers.keys().forall(x => workers.get(x) != Working({ task: ImplementTask }))
  // The gate presents the plan: approval implies a validated plan exists.
  val approveRequiresPlan: bool = approved implies planReady
  // "Never silently substitute a weaker model in the judgment roles": a
  // completed REPORT states the fallback limitation iff one was used.
  val reportHonesty: bool = reported implies reportedFallback == fallbackUsed
  // The coordinator never does the work itself: a worker is busy only during
  // the work phases (IMPLEMENT / VERIFY). Combined with the structure — the
  // only actions that touch `workers` are `delegate` and `workerDone`, and
  // the phase leaves IMPLEMENT/VERIFY and `verified` is set only through a
  // worker's report — this is the role separation the flow change introduced.
  // Written as if/else instead of `or` — see the note on plan().
  val workHappensInWorkers: bool =
    workers.keys().exists(x => workers.get(x) != Idle) implies
      if (phase == Implement) true else phase == Verify

  // --- Witnesses (each phase / documented path is reachable) -----------------
  val reachedClarify: bool = phase == Clarify
  val clarifyUsed: bool = asked
  val reachedImplement: bool = phase == Implement
  val reachedVerify: bool = phase == Verify
  val reachedReview: bool = phase == Review
  val reachedReport: bool = phase == Report
  val fixLoopUsed: bool = fixRounds >= 1
  val capReachedOpenItems: bool = phase == Report and fixRounds == 3
  val fallbackOccurred: bool = fallbackUsed
  val delegationUsed: bool = workers.keys().exists(x => workers.get(x) != Idle)
  val parallelChunks: bool =
    workers.keys().filter(x => workers.get(x) == Working({ task: ImplementTask })).size() >= 2
}

// Concrete instances: PRE_APPROVED and WORKERS are module parameters, so
// they must be fixed at instantiation to make the spec runnable.
module implTaskGate {
  import implementTask(PRE_APPROVED = false, WORKERS = Set(1, 2), BUGGY_FIX_CAP = false).*
}

module implTaskPreApproved {
  import implementTask(PRE_APPROVED = true, WORKERS = Set(1, 2), BUGGY_FIX_CAP = false).*
}

// Vulnerable variant for mizchi's counterexample→regression-test loop: the
// fix-round cap guard is removed (a review FAIL always increments fixRounds),
// so a fourth FAIL reaches fixRounds == 4 and violates fixRoundCap. The
// counterexample trace is locked as fixRoundOverflowCounterexample in the
// test module; the fixed model's deterministic gate is fixRoundCapSentinel.
// See spec/README.md "Mizchi-style gate".
module implTaskVulnerable {
  import implementTask(PRE_APPROVED = false, WORKERS = Set(1, 2), BUGGY_FIX_CAP = true).*
}
