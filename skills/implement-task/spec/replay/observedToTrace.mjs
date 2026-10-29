#!/usr/bin/env node
// observedToTrace.mjs — harness-observed tool-call log -> model-action trace.
//
// PROTO-3 IS TELEMETRY, NOT A GATE. The emitter records TOOL CALLS the
// harness observed; this mapper turns them into model actions conservatively
// and documents every inference. Where the log does not carry explicit
// evidence, the action is OMITTED — ambiguity must never manufacture success
// (review finding: the old mapper inferred approvals from any question,
// successes from transport status, Pass from a delivered reviewer answer,
// and appended an unobserved report).
//
// The emitted records (one JSON object per line) look like:
//   {"seq":0,"sid":"session-x","name":"ask_user_question","ok":true,
//    "qHead":"...plan is ready...","optsHead":"Approve|Adjust","outHead":"Approve"}
//   {"seq":1,"sid":"session-x","name":"subagent_worker","ok":true,
//    "promptHead":"...","outHead":"implemented chunk 1 ..."}
//   {"seq":3,"sid":"session-x","name":"subagent_frontier","ok":true,
//    "promptHead":"reviewer: judge the diff...","outHead":"Verdict: PASS"}
//
// Mapping rules (each heuristic is named so it can be audited):
//
//   - UNOBSERVABLE PREFIX: scopeDone/clarify/plan are internal phase moves,
//     not tool calls. They are ASSUMED valid and prepended. If the agent
//     skipped them, the harness cannot see it — the gate therefore checks
//     only the OBSERVABLE actions against the model.
//   - GATE: an `ask_user_question` counts as THE gate only when its recorded
//     option labels include "approve" (the skill's gate offers Approve /
//     Adjust; a plain clarification question does not) AND the call was not
//     denied (`ok:false` = rejected/denied -> no gate action at all). The
//     recorded answer text picks `adjust` vs `approve`; when the answer was
//     not captured, `approve` is assumed from the question's presence alone
//     (documented residual inference).
//   - WORKERS: subagent_worker / subagent_verify -> delegate + workerDone.
//     `ok` starts from the transport outcome and is forced false when the
//     recorded report head carries explicit failure evidence
//     (FAIL marker, nonzero "exit code:", "Verdict: FAIL"). Absence of
//     failure evidence is NOT proof of success — telemetry-grade.
//   - REVIEW: a subagent_frontier call whose prompt mentions review/verdict
//     maps to a review action ONLY when its recorded report head contains an
//     explicit uppercase PASS/FAIL token; FAIL wins when both appear. No
//     token -> no review action. A frontier PLAN call maps to nothing.
//   - REPORT: never emitted. Reporting is a final assistant message, not a
//     tool call — the harness cannot observe it, so proto-3 does not pretend
//     to. Report coverage stays with proto-2 self-reported traces.
//
// Usage:
//   node observedToTrace.mjs trace.observed.<sid>.jsonl > trace.json
//   node replay.mjs trace.json > replayTrace.qnt
//   quint test replayTrace.qnt --main=replayTrace   # GREEN = observed actions
//                                                      matched the model
//   node observedToTrace.mjs --self-check           # assert fixtures map

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Explicit failure evidence in a recorded report head (case-sensitive FAIL). */
const FAILURE_EVIDENCE = /\bFAIL\b|exit code: [1-9]|Verdict: FAIL/

/** Explicit reviewer verdict tokens (uppercase, matching reviewer-schema enum). */
const VERDICT_PASS = /\bPASS\b/
const VERDICT_FAIL = /\bFAIL\b/

function loadObserved(file) {
  return readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try { return JSON.parse(l) } catch (e) { throw new Error(`observed line ${i + 1}: ${e.message}`) }
    })
}

export function observedToTrace(obs) {
  // Unobservable-but-assumed prefix: scope done, task clear, plan ready.
  const trace = [{ a: 'scopeDone' }, { a: 'clarify', clear: true }, { a: 'plan', frontierOk: true }]

  // GATE: first gate-shaped ask_user_question before the first delegation.
  const firstWorker = obs.findIndex((r) => r.name === 'subagent_worker' || r.name === 'subagent_verify')
  for (const r of obs.slice(0, firstWorker === -1 ? obs.length : firstWorker)) {
    if (r.name !== 'ask_user_question') continue
    if (r.ok === false) break // denied/rejected question: no gate action
    const offered = String(r.optsHead || '')
    if (!/\bapprove\b/i.test(offered)) continue // not a gate question; ignore it
    if (/adjust/i.test(String(r.outHead || ''))) trace.push({ a: 'adjust' })
    else trace.push({ a: 'approve' })
    break // one gate action per trace; later questions are follow-ups
  }

  let workerSeq = 0
  for (const r of obs) {
    if (r.name === 'subagent_worker' || r.name === 'subagent_verify') {
      const task = r.name === 'subagent_worker' ? 'ImplementTask' : 'VerifyTask'
      const w = ++workerSeq
      const failed = typeof r.outHead === 'string' && FAILURE_EVIDENCE.test(r.outHead)
      trace.push({ a: 'delegate', w, task })
      trace.push({ a: 'workerDone', w, task, ok: !!r.ok && !failed })
    } else if (r.name === 'subagent_frontier') {
      const head = String(r.promptHead || '').toLowerCase()
      if (!head.includes('review') && !head.includes('verdict')) continue // plan call
      const out = String(r.outHead || '')
      const pass = VERDICT_PASS.test(out)
      const fail = VERDICT_FAIL.test(out)
      if (!pass && !fail) continue // no observed verdict: omit, don't invent
      trace.push({ a: 'review', v: fail ? 'Fail' : 'Pass' })
    }
    // other tool calls (bash, read, container_exec, ...) are not implement-task
    // actions and are ignored by the gate
  }
  // No automatic `report`: unobservable, see the header.
  return trace
}

const SELF_CHECKS = [
  {
    file: 'trace.observed.good.jsonl',
    expect: [
      { a: 'scopeDone' }, { a: 'clarify', clear: true }, { a: 'plan', frontierOk: true },
      { a: 'approve' },
      { a: 'delegate', w: 1, task: 'ImplementTask' }, { a: 'workerDone', w: 1, task: 'ImplementTask', ok: true },
      { a: 'delegate', w: 2, task: 'VerifyTask' }, { a: 'workerDone', w: 2, task: 'VerifyTask', ok: true },
      { a: 'review', v: 'Pass' },
    ],
  },
  {
    file: 'trace.observed.bad.jsonl',
    expect: [
      { a: 'scopeDone' }, { a: 'clarify', clear: true }, { a: 'plan', frontierOk: true },
      // no approve: the agent delegated without gating -> replay goes RED here
      { a: 'delegate', w: 1, task: 'ImplementTask' }, { a: 'workerDone', w: 1, task: 'ImplementTask', ok: true },
      { a: 'delegate', w: 2, task: 'VerifyTask' }, { a: 'workerDone', w: 2, task: 'VerifyTask', ok: true },
      { a: 'review', v: 'Fail' },
    ],
  },
  {
    file: 'trace.observed.clarify.jsonl',
    expect: [
      { a: 'scopeDone' }, { a: 'clarify', clear: true }, { a: 'plan', frontierOk: true },
      // a clarification question (no Approve option) must NOT become a gate;
      // implementing after it is exactly the deviation the gate should flag
      { a: 'delegate', w: 1, task: 'ImplementTask' }, { a: 'workerDone', w: 1, task: 'ImplementTask', ok: true },
    ],
  },
]

function selfCheck() {
  const dir = dirname(fileURLToPath(import.meta.url))
  let failed = 0
  for (const c of SELF_CHECKS) {
    const got = observedToTrace(loadObserved(join(dir, c.file)))
    if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
      console.error(`self-check: ${c.file} mapped to\n  ${JSON.stringify(got)}\nexpected\n  ${JSON.stringify(c.expect)}`)
      failed++
    }
  }
  if (failed) process.exit(1)
  console.log('ok')
}

if (process.argv[2] === '--self-check') {
  selfCheck()
} else {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: observedToTrace.mjs <trace.observed.<sid>.jsonl> | --self-check')
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(observedToTrace(loadObserved(file))))
}
