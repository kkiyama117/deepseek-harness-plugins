// verifyCompletion.qnt — formal model of the verification-before-completion skill
//
// The skill (SKILL.md) is the single completion closeout aggregator. Its flow
// is: before any success claim, classify destructive permission needs, run a
// FRESH falsifying check, read its complete result/scope, grade confidence
// (A | B | C), choose a receipt level (L0 | L1 | L2), then pick a stop state
// (done | blocked | needs-verification | scope-exceeded). If evidence is
// partial, stale, failing, or narrower than the claim, DOWNGRADE; never claim
// complete first and verify later.
//
// This model captures that flow as an executable phase state machine:
//   Working → Check → Graded → Stopped
// where the STOPPED phase carries one of four stop states. The skill's rules
// become guarded transitions and invariants; each documented path has a
// reachability witness.
//
// The central rule — "confidence C (partial evidence only) ⇒ do not claim
// full completion" — is the invariant `confidenceCNotDone`. The vulnerability
// toggle `BUGGY_CONF_C` removes that guard from `claim`, so a confidence-C
// trace can reach `done`, violating the invariant: the counterexample→sentinel
// pair (see README "Mizchi-style gate") locks the exact dangerous trace.
//
// See spec/README.md for the coverage map (skill rule → model element), what is
// deliberately not modeled, and how to run this spec.

module verifyCompletion {
  // --- Types ------------------------------------------------------------
  // The 4 phases of the closeout flow.
  //   Working — the agent is doing the task; no claim yet.
  //   Check   — a fresh falsifying check has run; its result/scope is read.
  //   Graded  — confidence is graded (A/B/C) and the receipt level is chosen.
  //   Stopped — a stop state is selected; terminal.
  type Phase = Working | Check | Graded | Stopped

  // Confidence grade (SKILL.md "Required Evidence Slots"):
  //   A — direct target plus relevant regression evidence; no meaningful unknown.
  //   B — direct target evidence with bounded residual risk.
  //   C — partial evidence only; do not claim full completion.
  type Confidence = A | B | C

  // Receipt level (SKILL.md L0/L1/L2):
  //   L0 — fast path, one sentence (tiny low-risk work).
  //   L1 — default receipt (non-trivial Aegis-shaped work).
  //   L2 — expanded (triggers in the L2 table; detail in expanded-closeout.md).
  type Receipt = L0 | L1 | L2

  // Stop state (SKILL.md "Completion Boundary"):
  //   done              — full completion; requires confidence A or B and
  //                        covered scope ⊇ claim scope and no unresolved complexity.
  //   blocked           — destructive needs scoped permission, hook/commit
  //                        failure, or complexity closure exceeded-unresolved.
  //   needsVerification — evidence insufficient or authority unclear; return
  //                        to framing/planning.
  //   scopeExceeded     — the task grew past its authorized stop; a downgrade.
  type Stop = Done | Blocked | NeedsVerification | ScopeExceeded

  // The scope relationship between fresh evidence and the claim:
  //   coversClaim — fresh evidence covers the whole task.
  //   narrower    — evidence is narrower than the claim (slice evidence).
  type Scope = CoversClaim | Narrower

  // --- Constants --------------------------------------------------------
  // True when the user gave scoped permission for a destructive action up
  // front (SKILL.md: "Destructive or irreversible work needs scoped
  // permission; warnings or broad assent do not grant it"). The fixed
  // instances pass DESTRUCTIVE_NEEDED = false; the destructive variant
  // passes true so the blocked-on-no-permission path is reachable there.
  const DESTRUCTIVE_NEEDED: bool

  // Experiment toggle for the counterexample→regression-test loop
  // (see spec/README.md "Mizchi-style gate"). When true, the confidence-C
  // guard is removed from `claim`, so a confidence-C work item can reach
  // `done` and violate `confidenceCNotDone`. The two production instances pass
  // BUGGY_CONF_C = false; only verifyCompletionVulnerable passes true.
  // Remove this const once the loop pattern is established elsewhere.
  const BUGGY_CONF_C: bool

  pure val BOOLS: Set[bool] = Set(false, true)
  pure val CONFS: Set[Confidence] = Set(A, B, C)
  pure val RECEIPTS: Set[Receipt] = Set(L0, L1, L2)
  pure val STOPS: Set[Stop] = Set(Done, Blocked, NeedsVerification, ScopeExceeded)

  // --- State --------------------------------------------------------------
  var phase: Phase
  var checkRan: bool          // a fresh falsifying check has run (step "run a fresh falsifying check")
  var confidence: Confidence   // the graded confidence (A/B/C); A until graded
  var scope: Scope              // does fresh evidence cover the whole claim?
  var receipt: Receipt          // the chosen receipt level; L0 until chosen
  var stop: Stop                // the selected stop state; Done until selected
  var complexityExceeded: bool  // complexity closure exceeded-unresolved (blocks completion)
  var scopedPermission: bool   // scoped permission was granted for destructive work
  var downgraded: bool          // a downgrade happened (narrower/partial/stale → stop signal)
  var claimed: bool             // a stop state has been claimed (terminal marker)

  // --- Init ----------------------------------------------------------------
  action init: bool = all {
    phase' = Working,
    checkRan' = false,
    confidence' = A,
    scope' = CoversClaim,
    receipt' = L0,
    stop' = Done,
    complexityExceeded' = false,
    scopedPermission' = false,
    downgraded' = false,
    claimed' = false,
  }

  // --- Actions (one per phase transition) ----------------------------------
  // Every action assigns every variable (x' = x to leave unchanged): the
  // branches of `step`'s `any { }` must share one effect.
  //
  // 1. runCheck — the agent runs a FRESH falsifying check and reads its full
  //    result/scope. `ok` = the check passed; `narrow` = the evidence is
  //    narrower than the claim. Only after this can confidence be graded.
  //    Guarded by phase == Working: "never claim complete first and verify
  //    later" — no claim before a fresh check ran.
  action runCheck(ok: bool, narrow: bool): bool = all {
    phase == Working,
    checkRan' = true,
    scope' = if (narrow) Narrower else CoversClaim,
    // confidence is graded AFTER the check in the Graded phase; here we only
    // record the evidence. The "ok=false" path is the failing-evidence
    // downgrade signal (SKILL.md Stop Signals: "evidence is ... failing").
    phase' = Check,
    confidence' = confidence,
    receipt' = receipt,
    stop' = stop,
    complexityExceeded' = complexityExceeded,
    scopedPermission' = scopedPermission,
    downgraded' = if (ok) downgraded else true,
    claimed' = claimed,
  }

  // 2. grade — grade the confidence from the fresh evidence and choose the
  //    receipt level. The receipt is orthogonal to the stop state: L0/L1/L2
  //    are output shapes, not completion authority ("Evidence is not
  //    completion authority").
  action grade(conf: Confidence, rcp: Receipt): bool = all {
    phase == Check,
    checkRan,
    checkRan' = checkRan,
    confidence' = conf,
    receipt' = rcp,
    phase' = Graded,
    scope' = scope,
    stop' = stop,
    complexityExceeded' = complexityExceeded,
    scopedPermission' = scopedPermission,
    downgraded' = downgraded,
    claimed' = claimed,
  }

  // 3. claim — select a stop state. This is the gated transition: the skill's
  //    rules constrain which stop state is reachable given the evidence.
  //
  //    Rules baked into the guards (each quoted from SKILL.md):
  //      (a) confidence C (partial evidence only) ⇒ NOT done.
  //      (b) evidence narrower than the claim ⇒ NOT done (claim scope ⊆ covered).
  //      (c) complexity closure exceeded-unresolved ⇒ blocked, not done.
  //      (d) destructive work without scoped permission ⇒ blocked.
  //
  //    The `chosen` parameter is the agent's desired stop; the action FORBIDS
  //    a desired `Done` that the guards reject, instead routing to the
  //    honest stop (blocked / needsVerification / scopeExceeded). When the
  //    guards allow Done, `chosen` is honored.
  //
  //    BUGGY_CONF_C removes guard (a): a confidence-C work item can reach
  //    done, violating confidenceCNotDone. The other guards stay intact so
  //    the violation is specifically the confidence-C hole, not a cascade.
  //
  //    Guard logic is written with nested `if` instead of `or`/`and` chains
  //    over a possibly-false operand — see ISSUES.md issue 1 (the Quint 0.32
  //    Rust backend mis-evaluates `false or X` as false). Each branch is a
  //    pure if/else, never `A or B`.
  action claim(chosen: Stop): bool = all {
    phase == Graded,
    checkRan,
    // Compute the effective stop state from the guards. The order mirrors
    // the skill: complexity and destructive-permission are BLOCK signals that
    // override any done intent; then confidence C and narrower scope are
    // downgrades; otherwise the chosen stop is honored.
    stop' =
      if (complexityExceeded)
        Blocked
      else if (DESTRUCTIVE_NEEDED and not(scopedPermission))
        Blocked
      else if (scope == Narrower)
        if (chosen == Done) ScopeExceeded else chosen
      else if (confidence == C)
        if (chosen == Done)
          if (BUGGY_CONF_C) Done else NeedsVerification
        else chosen
      else chosen,
    downgraded' =
      if (downgraded) true
      else if (scope == Narrower and chosen == Done) true
      else if (confidence == C and chosen == Done and not(BUGGY_CONF_C)) true
      else downgraded,
    phase' = Stopped,
    claimed' = true,
    checkRan' = checkRan,
    confidence' = confidence,
    scope' = scope,
    receipt' = receipt,
    complexityExceeded' = complexityExceeded,
    scopedPermission' = scopedPermission,
  }

  // 3'. grantScopedPermission — the authority grants scoped permission for
  //    the destructive action (SKILL.md: destructive work needs scoped
  //    permission; broad assent does not grant it). Models the repair path
  //    that unblocks a destructive task: once granted, `claim` can proceed.
  action grantScopedPermission: bool = all {
    DESTRUCTIVE_NEEDED,
    not(scopedPermission),
    scopedPermission' = true,
    phase' = phase,
    checkRan' = checkRan,
    confidence' = confidence,
    scope' = scope,
    receipt' = receipt,
    stop' = stop,
    complexityExceeded' = complexityExceeded,
    downgraded' = downgraded,
    claimed' = claimed,
  }

  // 4. resolveComplexity — complexity closure was exceeded-unresolved; the
  //    agent retires a path or adds a retirement trigger, clearing the block.
  //    (SKILL.md Complexity Downgrade: "New fallback/adapter/... needs a
  //    retired path or retirement trigger.")
  action resolveComplexity: bool = all {
    complexityExceeded,
    complexityExceeded' = false,
    phase' = phase,
    checkRan' = checkRan,
    confidence' = confidence,
    scope' = scope,
    receipt' = receipt,
    stop' = stop,
    scopedPermission' = scopedPermission,
    downgraded' = downgraded,
    claimed' = claimed,
  }

  // 5. markComplexity — the diff inspection finds complexity closure
  //    exceeded-unresolved (sets the block). This models the "Complexity
  //    Downgrade" inspection step that can happen during working/checking —
  //    NOT after a claim is made: complexity closure is evaluated BEFORE
  //    completion, and a claim is terminal. Guarded by phase != Stopped so
  //    the block cannot appear after a done claim (which would violate
  //    complexityBlocksDone retroactively).
  action markComplexity: bool = all {
    not(complexityExceeded),
    phase != Stopped,
    complexityExceeded' = true,
    phase' = phase,
    checkRan' = checkRan,
    confidence' = confidence,
    scope' = scope,
    receipt' = receipt,
    stop' = stop,
    scopedPermission' = scopedPermission,
    downgraded' = downgraded,
    claimed' = claimed,
  }

  action step: bool = {
    nondet ok = BOOLS.oneOf()
    nondet narrow = BOOLS.oneOf()
    nondet conf = CONFS.oneOf()
    nondet rcp = RECEIPTS.oneOf()
    nondet chosen = STOPS.oneOf()
    any {
      runCheck(ok, narrow),
      grade(conf, rcp),
      claim(chosen),
      grantScopedPermission,
      resolveComplexity,
      markComplexity,
    }
  }

  // --- Invariants (the skill's rules, checkable) -----------------------------
  // "Never claim complete first and verify later": done requires a fresh
  // falsifying check ran. (Also enforced structurally — claim is only enabled
  // in Graded, which only follows Check — but the invariant pins it.)
  val checkBeforeComplete: bool = (stop == Done and claimed) implies checkRan

  // "confidence C (partial evidence only) ⇒ do not claim full completion":
  // a claimed done implies confidence was A or B. This is the invariant the
  // BUGGY_CONF_C toggle exists to break.
  val confidenceCNotDone: bool = (stop == Done and claimed) implies confidence != C

  // "Claim only what fresh evidence covers; slice evidence cannot close the
  // whole task": a claimed done implies the evidence covered the whole claim
  // (scope != Narrower).
  val claimWithinCoverage: bool = (stop == Done and claimed) implies scope == CoversClaim

  // "Complexity Closure: exceeded-unresolved blocks completion": a claimed
  // done implies complexity closure is NOT exceeded-unresolved.
  val complexityBlocksDone: bool = (stop == Done and claimed) implies not(complexityExceeded)

  // "Destructive or irreversible work needs scoped permission; warnings or
  // broad assent do not grant it": a claimed done under DESTRUCTIVE_NEEDED
  // implies scoped permission was granted. Written with if/else instead of
  // `or` over a possibly-false operand — see ISSUES.md issue 1.
  val destructiveNeedsScopedPermission: bool =
    if (DESTRUCTIVE_NEEDED) (stop == Done and claimed) implies scopedPermission else true

  // Phase discipline: claim is only reached after the Check phase (fresh
  // evidence). A claimed stop implies the phase advanced past Working.
  val claimOnlyAfterGraded: bool = claimed implies phase == Stopped

  // --- Witnesses (each documented path is reachable) -------------------------
  val reachedCheck: bool = phase == Check
  val reachedGraded: bool = phase == Graded
  val reachedStopped: bool = phase == Stopped
  val checkRanWitness: bool = checkRan
  val confidenceAReached: bool = confidence == A and phase == Graded
  val confidenceBReached: bool = confidence == B and phase == Graded
  val confidenceCReached: bool = confidence == C and phase == Graded
  val receiptL0Reached: bool = receipt == L0 and phase == Graded
  val receiptL1Reached: bool = receipt == L1 and phase == Graded
  val receiptL2Reached: bool = receipt == L2 and phase == Graded
  val stopDoneReached: bool = stop == Done and phase == Stopped
  val stopBlockedReached: bool = stop == Blocked and phase == Stopped
  val stopNeedsVerificationReached: bool = stop == NeedsVerification and phase == Stopped
  val stopScopeExceededReached: bool = stop == ScopeExceeded and phase == Stopped
  val downgradeHappened: bool = downgraded
  val complexityBlockedHappened: bool = stop == Blocked and phase == Stopped and complexityExceeded
}

// Concrete instances: DESTRUCTIVE_NEEDED and BUGGY_CONF_C are module parameters,
// so they must be fixed at instantiation to make the spec runnable.
//
// Default gate: no destructive work in this task; confidence-C guard intact.
module verifyCompletionGate {
  import verifyCompletion(DESTRUCTIVE_NEEDED = false, BUGGY_CONF_C = false).*
}

// Destructive variant: the task needs scoped permission for a destructive
// action; the blocked-on-no-permission path is reachable, and granting it
// unblocks completion. Confidence-C guard intact.
module verifyCompletionDestructive {
  import verifyCompletion(DESTRUCTIVE_NEEDED = true, BUGGY_CONF_C = false).*
}

// Vulnerable variant for the counterexample→regression-test loop: the
// confidence-C guard is removed from `claim`, so a confidence-C work item can
// reach `done` and violate confidenceCNotDone. The counterexample trace is
// locked as confidenceCCounterexample in the test module; the fixed model's
// deterministic gate is confidenceCSentinel. See spec/README.md
// "Mizchi-style gate".
module verifyCompletionVulnerable {
  import verifyCompletion(DESTRUCTIVE_NEEDED = false, BUGGY_CONF_C = true).*
}