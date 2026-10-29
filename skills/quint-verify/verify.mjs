#!/usr/bin/env node
// verify.mjs — quint-llm's /verify flow ported to run INSIDE the DSH quint
// container (node v20 + quint 0.32 are on PATH). The agent invokes it through
// container_exec; this script shells out to `quint` for each check.
//
// It runs typecheck, then each invariant (expect SATISFIED = safety holds = ✅)
// and all witnesses together (expect REACHED in >0 traces = liveness = ✅),
// classifies results with the witness/invariant judgment convention (see
// quint-lang/guidelines/simulations.md — NOT duplicated here), and emits a
// structured verification report (verification-report.schema.json) plus a
// human verdict table.
//
//   witness reached  (violated) = ✅ good  — scenario is reachable
//   witness 0-traces (satisfied) = ⚠️ concern — unreachable / over-constrained
//   invariant satisfied          = ✅ good  — safety holds in sampled traces
//   invariant violated           = ❌ bug   — a trace disproves it
//
// Usage (inside the container, repo mounted at /work):
//   node verify.mjs <spec.qnt> <main> \
//     [--invariants n1 n2 ...] [--witnesses w1 w2 ...] \
//     [--max-steps N] [--max-samples M] [--out report.json]
//
// If <spec>.verify.json sits next to the spec ({"invariants": [...],
// "witnesses": [...], "maxSteps": N, "maxSamples": M}), it supplies the
// defaults and the flags become optional; an explicit flag overrides it.
//
// Exit code: 0 = verdict pass, 1 = fail (any invariant violated or witness
// unreachable), 2 = typecheck/usage error.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
// Parse: <spec.qnt> <main> [--invariants n1 n2 ...] [--witnesses w1 w2 ...]
//         [--max-steps N] [--max-samples M] [--out report.json]
const LIST_FLAGS = new Set(['--invariants', '--witnesses'])
const VALUE_FLAGS = new Set(['--max-steps', '--max-samples', '--out'])
function consumeList(flag) {
  const i = args.indexOf(flag)
  if (i < 0) return []
  const out = []
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j])
  return out
}
function consumeValue(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const pos = []
{
  let k = 0
  while (k < args.length) {
    const t = args[k]
    if (LIST_FLAGS.has(t)) { k++; while (k < args.length && !args[k].startsWith('--')) k++ }
    else if (VALUE_FLAGS.has(t)) { k += 2 }
    else { pos.push(t); k++ }
  }
}
const SPEC = pos[0]
const MAIN = pos[1]
const OUT = consumeValue('--out', null)

// Sidecar: <spec>.verify.json next to the spec holds the verification config
// (invariants / witnesses / maxSteps / maxSamples). When present it supplies
// the defaults; an explicit CLI flag overrides it. This is the auto-extract
// path — `node verify.mjs spec.qnt main` needs no --invariants/--witnesses.
function loadSidecar(spec) {
  if (!spec) return null
  const sidecarPath = spec.replace(/\.qnt$/, '.verify.json')
  if (!existsSync(sidecarPath)) return null
  try {
    return JSON.parse(readFileSync(sidecarPath, 'utf8'))
  } catch (e) {
    console.error(`sidecar unreadable (ignored): ${sidecarPath}: ${e.message}`)
    return null
  }
}
const sidecar = loadSidecar(SPEC)

const INVARIANTS = args.includes('--invariants') ? consumeList('--invariants') : (sidecar?.invariants ?? [])
const WITNESSES = args.includes('--witnesses') ? consumeList('--witnesses') : (sidecar?.witnesses ?? [])
const MAX_STEPS = Number(args.includes('--max-steps') ? consumeValue('--max-steps', '40') : (sidecar?.maxSteps ?? 40))
const MAX_SAMPLES = Number(args.includes('--max-samples') ? consumeValue('--max-samples', '1000') : (sidecar?.maxSamples ?? 1000))

if (!SPEC || !MAIN) {
  console.error('usage: verify.mjs <spec.qnt> <main> [--invariants ...] [--witnesses ...] [--max-steps N] [--max-samples M] [--out report.json]')
  process.exit(2)
}

function runQuint(quintArgs) {
  try {
    return execSync(`quint ${quintArgs.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

function typecheck() {
  const out = runQuint(['typecheck', SPEC])
  return { ok: !/\berror\b/i.test(out), out }
}

// Invariant: SATISFIED (✅) = "[ok] No violation found"; VIOLATED (❌) = that
// line is absent (quint prints a counterexample trace instead). Note: quint
// ALWAYS prints "An example execution:" + a sample trace, even on success, so
// that header is NOT a violation signal — only the absence of "No violation
// found" is.
function runInvariant(name) {
  const out = runQuint(['run', SPEC, `--main=${MAIN}`, '--invariant', name, `--max-steps=${MAX_STEPS}`, `--max-samples=${MAX_SAMPLES}`])
  const satisfied = /No violation found/.test(out)
  const seedMatch = out.match(/--seed=(0x[0-9a-f]+)/)
  return { name, result: satisfied ? 'satisfied' : 'violated', ...(!satisfied && seedMatch ? { seed: seedMatch[1] } : {}) }
}

// Witness (run together): REACHED (✅, schema: "violated") = witnessed in >0
// traces; UNREACHED (⚠️, schema: "satisfied") = 0 traces.
function runWitnesses() {
  if (WITNESSES.length === 0) return []
  const out = runQuint(['run', SPEC, `--main=${MAIN}`, '--witnesses', ...WITNESSES, `--max-steps=${MAX_STEPS}`, `--max-samples=${MAX_SAMPLES}`])
  const details = []
  for (const w of WITNESSES) {
    const m = out.match(new RegExp(`${w}\\s+was witnessed in\\s+(\\d+)\\s+trace\\(s\\)\\s+out of\\s+(\\d+)`))
    if (m) {
      const traces = Number(m[1])
      details.push({ name: w, result: traces > 0 ? 'violated' : 'satisfied', traces, explored: Number(m[2]) })
    } else {
      details.push({ name: w, result: 'satisfied', traces: 0, explored: 0, note: 'not reported in output' })
    }
  }
  return details
}

const tc = typecheck()
if (/error/i.test(tc.out)) {
  console.error('TYPECHECK FAILED:\n' + tc.out)
  process.exit(2)
}

const invDetails = INVARIANTS.map(runInvariant)
const witDetails = runWitnesses()

const invViolated = invDetails.filter((d) => d.result === 'violated').length
const witReached = witDetails.filter((d) => d.result === 'violated').length
const witUnreached = witDetails.filter((d) => d.result === 'satisfied').length

const report = {
  configuration: { module: MAIN, parameters: {} },
  invariants: {
    total: invDetails.length,
    satisfied: invDetails.length - invViolated,
    violated: invViolated,
    details: invDetails,
  },
  witnesses: {
    total: witDetails.length,
    violated: witReached,        // schema term: violated = reached = good
    satisfied: witUnreached,      // schema term: satisfied = unreached = concern
    details: witDetails,
  },
  verdict: (invViolated === 0 && witUnreached === 0) ? 'pass' : 'fail',
}

// Human verdict table (stdout), JSON report (file if --out).
const bar = '─'.repeat(64)
console.log(bar)
console.log(`quint-verify  spec=${SPEC}  main=${MAIN}  steps=${MAX_STEPS} samples=${MAX_SAMPLES}`)
console.log(bar)
console.log('Invariants (safety — SATISFIED = ✅, VIOLATED = ❌ bug):')
for (const d of invDetails) {
  const mark = d.result === 'satisfied' ? '✅' : '❌'
  console.log(`  ${mark} ${d.name.padEnd(28)} ${d.result}${d.seed ? '  seed=' + d.seed : ''}`)
}
console.log('Witnesses (liveness — REACHED = ✅, 0-traces = ⚠️ unreachable):')
for (const d of witDetails) {
  const mark = d.result === 'violated' ? '✅' : '⚠️'
  console.log(`  ${mark} ${d.name.padEnd(28)} reached ${d.traces}/${d.explored}`)
}
console.log(bar)
console.log(`invariants: ${report.invariants.satisfied}/${report.invariants.total} satisfied, ${invViolated} violated`)
console.log(`witnesses:  ${witReached}/${report.witnesses.total} reached, ${witUnreached} unreachable`)
console.log(`verdict:    ${report.verdict === 'pass' ? '✅ pass' : '❌ fail'}`)
console.log(bar)

if (OUT) {
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
  console.log(`report written: ${OUT}`)
}

process.exit(report.verdict === 'pass' ? 0 : 1)