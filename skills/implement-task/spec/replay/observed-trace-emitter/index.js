// observed-trace-emitter — harness-observed emitter for the implement-task
// Quint replay gate (mizchi-style, proto-3).
//
// Proto-2's gate relied on the coordinator honestly appending its own phase
// transitions to trace.jsonl — it could omit a step. This plugin closes that
// gap: it listens to the Cordis `tools/result` event, which the harness fires
// on EVERY tool dispatch with the frozen exec (tool name + arguments) and the
// result (isError). The agent cannot suppress an event the harness already
// emitted, so the replay gate now runs on what the agent actually did.
//
// Concurrency safety (review fix): writes are APPEND-ONLY into a PER-SESSION
// log file, and every write runs inside ONE module-level promise chain. All
// listeners share the single harness process/event loop, so that chain is a
// correct FIFO mutex — parallel tool calls can no longer interleave a
// read-modify-write pair, and two sessions can never mix records into one
// file. Each record carries its session id (`sid`).
//
// Only scalar leaf fields are read from the frozen live exec/result; the live
// objects are never JSON.stringified (per Cordis host-plugin guidance).
//
// Install as a DSH bundle:
//   dsh plugin --profile <name> add ./spec/replay/observed-trace-emitter
//   # then restart the harness
// See README.md for the format, the mapper, and the known blocker.

export const name = 'observed-trace-emitter'

// Directory holding the observed logs — one file per session:
//   trace.observed.<session-id>.jsonl
// Repoint at another skill's spec/replay/ directory to gate a different model.
const LOG_DIR = '/data/softwares/deepseek-harness-plugins/skills/implement-task/spec/replay'

const HEAD_LEN = 160

/** First string worth keeping from a frozen value; '' when nothing matches. */
function head(value, len = HEAD_LEN) {
  if (typeof value === 'string') return value.slice(0, len)
  return ''
}

/**
 * Head of the first text block of a frozen ToolResult ({@code content: ContentBlock[]},
 * block {@code {type:'text', text}}). Defensive leaf reads only; never throws.
 */
function resultTextHead(result, len = HEAD_LEN) {
  try {
    const content = result && result.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          return block.text.slice(0, len)
        }
      }
    }
  } catch (e) { /* live-data shape drift must not break the observer */ }
  return ''
}

/** Filename-safe session id; 'unknown' when the exec has no agent/session. */
function sessionId(exec) {
  let raw = ''
  try { raw = String(exec?.agent?.session?.id ?? '') } catch (e) { /* stay unknown */ }
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return safe || 'unknown'
}

export function apply(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const counters = new Map() // sid -> next seq
  // FIFO write mutex: every append chains onto this tail, so two parallel
  // tool results can never interleave read+write on the same log file.
  let writeTail = Promise.resolve()

  ctx.effect(() => {
    const off = ctx.on('tools/result', (exec, result) => {
      // Fire-and-forget async: tools/result is an emit event; the listener
      // returns undefined and must never block or disrupt the tool pipeline.
      ;(async () => {
        try {
          const sid = sessionId(exec)
          const rec = {
            seq: counters.get(sid) ?? 0,
            sid,
            name: exec.name,
            ok: !!(result && result.isError === false),
          }
          counters.set(sid, rec.seq + 1)
          const args = exec.arguments
          if (args && typeof args === 'object') {
            if (typeof args.prompt === 'string') rec.promptHead = args.prompt.slice(0, HEAD_LEN)
            if (typeof args.description === 'string') rec.desc = args.description
            if (typeof args.command === 'string') rec.cmdHead = args.command.slice(0, HEAD_LEN)
            // Evidence for the mapper: the gate question's own text and option
            // labels (an approval gate offers Approve/Adjust options; a plain
            // clarification question does not).
            if (exec.name === 'ask_user_question' && Array.isArray(args.questions)) {
              const q = args.questions[0]
              if (q && typeof q === 'object') {
                rec.qHead = head(q.question)
                if (Array.isArray(q.options)) {
                  rec.optsHead = q.options
                    .map((o) => (o && typeof o.label === 'string' ? o.label : ''))
                    .filter((s) => s !== '')
                    .join('|')
                    .slice(0, HEAD_LEN)
                }
              }
            }
          }
          // Outcome evidence: what the tool actually reported (the user's gate
          // answer, a worker/verify/frontier report's first text block).
          if (['ask_user_question', 'subagent_worker', 'subagent_verify', 'subagent_frontier'].includes(exec.name)) {
            const out = resultTextHead(result)
            if (out !== '') rec.outHead = out
          }
          const target = await fs.resolve(`${LOG_DIR}/trace.observed.${sid}.jsonl`)
          const line = JSON.stringify(rec) + '\n'
          writeTail = writeTail.then(async () => {
            try {
              let prev = ''
              try { prev = await fs.readText(target) } catch (e) { /* first line */ }
              await fs.writeText(target, prev + line)
            } catch (e) { /* an observer must never disrupt the tool pipeline */ }
          })
          await writeTail
        } catch (e) {
          // An observer must never disrupt the tool pipeline.
        }
      })()
    })
    return off
  })
}
