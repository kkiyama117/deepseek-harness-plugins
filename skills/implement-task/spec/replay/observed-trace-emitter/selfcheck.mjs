#!/usr/bin/env node
// selfcheck.mjs — offline smoke test for the emitter's write path (no Cordis,
// no harness): a mock fs + mock ctx fire parallel tools/result events from two
// sessions and the run asserts per-session files, FIFO append order, session
// ids, and that a gate question's evidence fields were captured.
//   node selfcheck.mjs   # prints "ok" and leaves nothing behind

import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ote-check-'))

// Mock of the host fs service surface the emitter uses.
const fs = {
  async resolve(path) { return { targetKey: path, displayPath: path } },
  async readText(target) { return readFileSync(target.targetKey, 'utf8') },
  async writeText(target, content) { writeFileSync(target.targetKey, content) },
}

const listeners = []
const ctx = {
  get() { return fs },
  effect(fn) { fn() }, // register immediately; disposer bookkeeping not needed here
  on(event, handler) { listeners.push(handler); return () => {} },
}

// Point LOG_DIR at the temp dir for this run.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const patched = source.replace(
  /^const LOG_DIR = .*$/m,
  `const LOG_DIR = ${JSON.stringify(dir)}`,
)
if (patched === source) throw new Error('selfcheck: LOG_DIR line not found')
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(patched).toString('base64')
const { apply } = await import(dataUrl)

apply(ctx)

// exec helpers: two sessions plus agentless events (session id -> unknown).
const exec = (name, args, sid) => ({ name, arguments: args, agent: sid === undefined ? undefined : { session: { id: sid } } })
const result = (isError, text) => ({ isError, content: [{ type: 'text', text }] })

const emit = (execArgs, res) => {
  for (const l of listeners) l(execArgs, res)
}

// Fire 40 events across two sessions with zero awaiting between them:
// worst-case interleaving for a naive read-modify-write.
for (let i = 0; i < 20; i++) {
  emit(exec('bash', { command: `echo a${i}` }, 'session-A'), result(false, 'ok'))
  emit(exec('subagent_worker', { prompt: 'work' }, 'session-B'), result(false, `chunk ${i} done`))
}
emit(exec('ask_user_question', { questions: [{ question: 'Proceed?', options: [{ label: 'Approve' }, { label: 'Adjust' }] }] }, 'session-B'), result(false, 'Approve'))
emit(exec('read', {}), result(false, 'x')) // no agent/session at all

// The emitter is fire-and-forget by design; wait until every expected log
// exists and its size stops growing (bounded).
const expected = ['trace.observed.session-A.jsonl', 'trace.observed.session-B.jsonl', 'trace.observed.unknown.jsonl']
for (let waited = 0; waited < 2000; waited += 10) {
  await new Promise((r) => setTimeout(r, 10))
  const sizes = expected.map((f) => { try { return readFileSync(join(dir, f), 'utf8').length } catch { return -1 } })
  if (sizes.every((n) => n >= 0)) {
    await new Promise((r) => setTimeout(r, 10))
    const again = expected.map((f) => readFileSync(join(dir, f), 'utf8').length)
    if (again.join() === sizes.join()) break
  }
}

let failures = 0
const check = (cond, message) => { if (!cond) { console.error(`selfcheck: ${message} (dir: ${existsSync(dir) ? readdirSync(dir) : '(gone)'})`); failures++ } }

const fileA = join(dir, 'trace.observed.session-A.jsonl')
const fileB = join(dir, 'trace.observed.session-B.jsonl')
const fileU = join(dir, 'trace.observed.unknown.jsonl')

check(existsSync(fileA), 'session-A log missing')
check(existsSync(fileB), 'session-B log missing')
check(existsSync(fileU), 'unknown-session log missing')

const linesA = existsSync(fileA) ? readFileSync(fileA, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
const linesB = existsSync(fileB) ? readFileSync(fileB, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
const linesU = existsSync(fileU) ? readFileSync(fileU, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []

check(linesA.length === 20, `session-A should hold 20 records, got ${linesA.length}`)
check(linesB.length === 21, `session-B should hold 21 records, got ${linesB.length}`)
check(linesU.length === 1 && linesU[0]?.name === 'read', 'agentless event should land in unknown')

// FIFO order inside each session: bash echo a0 .. a19 in append order.
const cmds = linesA.filter((r) => r.name === 'bash').map((r) => r.cmdHead)
check(cmds.join(',') === Array.from({ length: 20 }, (_, i) => `echo a${i}`).join(','), `session-A order broken: ${cmds.slice(0, 3)}...`)
check(linesA.every((r) => r.sid === 'session-A'), 'session-A record leaked a foreign sid')
check(linesB.every((r) => r.sid === 'session-B' && r.seq === linesB.indexOf(r)), 'session-B seq/sid inconsistent')

const gate = linesB.find((r) => r.name === 'ask_user_question')
check(gate !== undefined && gate.optsHead === 'Approve|Adjust' && gate.outHead === 'Approve', 'gate evidence fields missing')

rmSync(dir, { recursive: true, force: true })
if (failures) process.exit(1)
console.log('ok')
