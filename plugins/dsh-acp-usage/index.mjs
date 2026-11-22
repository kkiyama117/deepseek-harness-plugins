import fs from 'node:fs';
import path from 'node:path';

/** Plugin id for the composition row. */
export const name = 'acp-usage';

/** Receive every committed Session event in the process, subagent children included. */
export const inject = ['sessions'];

const USAGE_FIELDS = [
  ['input', 'inputTokens'],
  ['output', 'outputTokens'],
  ['cache_read', 'cacheReadTokens'],
  ['cache_write', 'cacheWriteTokens'],
  ['reasoning', 'reasoningTokens'],
];

function plainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

/** Sum one attempt's usage into a step's usage state, as Core's headless JSON stream does. */
export function addAttemptUsage(state, next) {
  if (next === undefined) return { usage: state.usage, complete: false };
  if (state.usage === undefined) return { usage: next, complete: state.complete };
  const total = state.usage;
  const sum = (a, b) => a === undefined || b === undefined ? undefined : a + b;
  const totalTokens = sum(total.totalTokens, next.totalTokens);
  const cacheReadTokens = sum(total.cacheReadTokens, next.cacheReadTokens);
  const cacheWriteTokens = sum(total.cacheWriteTokens, next.cacheWriteTokens);
  const reasoningTokens = sum(total.reasoningTokens, next.reasoningTokens);
  return {
    usage: {
      inputTokens: total.inputTokens + next.inputTokens,
      outputTokens: total.outputTokens + next.outputTokens,
      ...totalTokens === undefined ? {} : { totalTokens },
      ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
      ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
      ...reasoningTokens === undefined ? {} : { reasoningTokens },
    },
    complete: state.complete,
  };
}

/** Return the usage of a stream's last usage chunk, or undefined when it has none. */
export function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
  }
  return undefined;
}

/** Escape newlines and other control characters so one record fits one stderr line. */
export const sanitize = value =>
  String(value)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');

/** Return the stderr line for one finished turn's usage record. */
export function usageLine(record) {
  let line = `dsh: usage: session=${sanitize(record.session)}`;
  if ('parent_session' in record) line += ` parent_session=${sanitize(record.parent_session)}`;
  line += ` cwd=${sanitize(record.cwd)} steps=${record.steps}`;
  for (const [label] of USAGE_FIELDS) {
    if (label in record) line += ` ${label}=${record[label]}`;
  }
  if (record.incomplete === true) line += ' incomplete';
  return `${line}\n`;
}

/** Validate the composition row's config and return its optional JSONL file path. */
export function resolveConfig(config) {
  if (config === undefined || config === null) return { file: undefined };
  if (!plainObject(config)) throw new Error('acp-usage: config must be an object');
  for (const key of Object.keys(config)) {
    if (key !== 'file') throw new Error(`acp-usage: unknown config key ${key}`);
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'file')) return { file: undefined };
  const file = config.file;
  if (typeof file !== 'string' || file.length === 0 || !path.isAbsolute(file) || file.includes('\0')) {
    throw new Error('acp-usage: file must be an absolute path');
  }
  return { file };
}

function freshState(turn) {
  return {
    turn,
    steps: 0,
    totals: new Map(),
    incomplete: false,
    firstRequestInput: undefined,
    stepUsage: { usage: undefined, complete: true },
  };
}

function addStep(state) {
  const { usage, complete } = state.stepUsage;
  const stepUsage = complete && usage !== undefined ? usage : undefined;
  state.stepUsage = { usage: undefined, complete: true };
  state.steps += 1;
  if (stepUsage === null || typeof stepUsage !== 'object') {
    state.incomplete = true;
    return;
  }
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reported = false;
  for (const [label, key] of USAGE_FIELDS) {
    const value = stepUsage[key];
    if (!Number.isFinite(value) || value < 0) continue;
    reported = true;
    state.totals.set(label, (state.totals.get(label) ?? 0) + value);
    if (label === 'input') input = value;
    else if (label === 'cache_read') cacheRead = value;
    else if (label === 'cache_write') cacheWrite = value;
  }
  if (!reported) {
    state.incomplete = true;
    return;
  }
  if (state.steps === 1) state.firstRequestInput = input + cacheRead + cacheWrite;
}

function requestConfig(session) {
  if (typeof session.requestHeader !== 'function') return undefined;
  try {
    return session.requestHeader()?.config;
  } catch {
    return undefined;
  }
}

function resolveCwd(cwd, realpath) {
  if (typeof cwd !== 'string') return '';
  try {
    return realpath(cwd);
  } catch {
    return cwd;
  }
}

function failureName(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code;
  return error?.name;
}

function usageRecord(session, state, { now, realpath }) {
  const header = session.header;
  const record = {
    ts: now().toISOString(),
    session: header.id,
  };
  if (header.origin === 'subagent') {
    record.parent_session = typeof header.parentSession === 'string' ? header.parentSession : '';
  }
  record.cwd = resolveCwd(header.cwd, realpath);
  const config = requestConfig(session);
  record.provider = stringOrEmpty(config?.provider);
  record.model = stringOrEmpty(config?.model);
  record.reasoning_effort = stringOrEmpty(config?.reasoningEffort);
  record.steps = state.steps;
  for (const [label] of USAGE_FIELDS) {
    if (state.totals.has(label)) record[label] = state.totals.get(label);
  }
  if (state.firstRequestInput !== undefined) record.first_request_input = state.firstRequestInput;
  if (state.incomplete) record.incomplete = true;
  return record;
}

/** Build the session/event listener that writes one line and one record per finished turn. */
export function createListener({ writeLine, appendRecord, warn, now, realpath }) {
  const states = new WeakMap();
  const warnSafely = message => {
    try {
      warn(message);
    } catch {}
  };
  return (session, event) => {
    try {
      const type = event?.type;
      if (type === 'turn/start') {
        states.set(session, freshState(event.data.turn));
        return undefined;
      }
      const state = states.get(session);
      if (state === undefined) return undefined;
      if (type === 'assistant/attempt') {
        state.stepUsage = addAttemptUsage(state.stepUsage, streamUsage(event.data.stream));
      } else if (type === 'assistant/message') {
        state.stepUsage = addAttemptUsage(state.stepUsage, event.data.usage ?? streamUsage(event.data.stream));
      } else if (type === 'step/end') {
        addStep(state);
      } else if (type === 'turn/end' && event.data.turn === state.turn) {
        const record = usageRecord(session, state, { now, realpath });
        states.delete(session);
        try {
          writeLine(usageLine(record));
        } catch {
          warnSafely(`acp-usage: stderr write failed for session ${record.session}`);
        }
        if (appendRecord !== undefined) {
          try {
            appendRecord(JSON.stringify(record) + '\n');
          } catch (error) {
            warnSafely(`acp-usage: usage file append failed for session ${record.session}: ${failureName(error)}`);
          }
        }
      }
    } catch {
      warnSafely('acp-usage: usage tracking failed');
    }
    return undefined;
  };
}

/** Register the session/event listener with the plugin context. */
export function apply(ctx, config) {
  const { file } = resolveConfig(config);
  const appendRecord = file === undefined ? undefined : text => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text, { mode: 0o600 });
  };
  ctx.on('session/event', createListener({
    writeLine: text => process.stderr.write(text),
    appendRecord,
    warn: message => ctx.logger.warn(message),
    now: () => new Date(),
    realpath: fs.realpathSync,
  }));
}
