/** Hint-file contract shared by the headless producer and the web-side consumer. */

export const HINT_VERSION = 1;

export const MALFORMED_HINT = 'malformed-hint';
export const UNKNOWN_WORKSPACE = 'unknown-workspace';
export const NO_WORKSPACE_FOR_CWD = 'no-workspace-for-cwd';
export const ATTACH_FAILED = 'attach-failed';
export const SESSION_NOT_READY = 'session-not-ready';
export const EXPIRED = 'expired';

const DISPOSITION = Object.freeze({
  [MALFORMED_HINT]: 'rejected',
  [UNKNOWN_WORKSPACE]: 'rejected',
  [NO_WORKSPACE_FOR_CWD]: 'rejected',
  [ATTACH_FAILED]: 'rejected',
  [SESSION_NOT_READY]: 'retry',
  [EXPIRED]: 'rejected',
});

const malformed = () => ({ ok: false, reason: MALFORMED_HINT });

/**
 * Parse one hint file into a validated hint.
 * @param fileName - Hint file name; its stem must equal the hint's sessionId.
 * @param text - File contents.
 * @returns the hint, or the malformed reason when any field is invalid.
 */
export function parseHint(fileName, text) {
  if (typeof fileName !== 'string' || !fileName.endsWith('.json')) return malformed();
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return malformed();
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return malformed();
  if (record.version !== HINT_VERSION) return malformed();
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return malformed();
  if (fileName.slice(0, -'.json'.length) !== record.sessionId) return malformed();
  const workspace = record.workspace;
  if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) return malformed();
  if (workspace.kind === 'id') {
    if (typeof workspace.id !== 'string' || workspace.id === '') return malformed();
    return { ok: true, hint: { version: HINT_VERSION, sessionId: record.sessionId, workspace: { kind: 'id', id: workspace.id } } };
  }
  if (workspace.kind === 'cwd') {
    return { ok: true, hint: { version: HINT_VERSION, sessionId: record.sessionId, workspace: { kind: 'cwd' } } };
  }
  return malformed();
}

/**
 * Serialize one hint to the file format parsed by {@link parseHint}.
 * @param hint - Hint with `sessionId` and `workspace`.
 * @returns UTF-8 JSON text.
 */
export function serializeHint(hint) {
  return JSON.stringify({ version: HINT_VERSION, sessionId: hint.sessionId, workspace: hint.workspace });
}

/**
 * Read the producer's target workspace from the `DSH_WORKSPACE_ID` value.
 * @param value - Environment value.
 * @returns the workspace spec, or undefined when unset or empty.
 */
export function workspaceSpecFromEnv(value) {
  if (value === undefined || value === '') return undefined;
  return value === 'cwd' ? { kind: 'cwd' } : { kind: 'id', id: value };
}

/**
 * Classify an `attachSession` rejection: cwd validation versus everything else.
 * @param error - Rejection value from the official attach call.
 * @returns the attach-failed or session-not-ready reason.
 */
export function classifyAttachError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("cannot attach session '") && message.includes('its cwd')
    ? ATTACH_FAILED
    : SESSION_NOT_READY;
}

const outcomeFor = (reason) => ({ kind: DISPOSITION[reason], reason });

async function attachTo(workspace, sessionId) {
  try {
    await workspace.attachSession(sessionId);
    return { kind: 'attached', workspaceId: workspace.id };
  } catch (error) {
    return outcomeFor(classifyAttachError(error));
  }
}

async function resolveById(hint, { registry }) {
  const workspace = registry.get(hint.workspace.id);
  if (workspace === undefined) return outcomeFor(UNKNOWN_WORKSPACE);
  return await attachTo(workspace, hint.sessionId);
}

async function resolveByCwd(hint, { registry, readSessionCwd }) {
  let cwd;
  try {
    cwd = await readSessionCwd(hint.sessionId);
  } catch {
    return outcomeFor(SESSION_NOT_READY);
  }
  if (cwd === undefined) return outcomeFor(SESSION_NOT_READY);
  const workspace = registry.list().find(candidate => candidate.path === cwd);
  if (workspace === undefined) return outcomeFor(NO_WORKSPACE_FOR_CWD);
  return await attachTo(workspace, hint.sessionId);
}

const RESOLVERS = { id: resolveById, cwd: resolveByCwd };

/**
 * Decide what should happen to one hint file. Pure: all I/O arrives through dependencies.
 * @param input - File name, contents, modification time, clock, registry, and cwd reader.
 * @returns attached, retry, or rejected.
 */
export async function processHint({ fileName, text, mtimeMs, now, registry, maxPendingMs, readSessionCwd }) {
  const parsed = parseHint(fileName, text);
  const outcome = parsed.ok
    ? await RESOLVERS[parsed.hint.workspace.kind](parsed.hint, { registry, readSessionCwd })
    : outcomeFor(parsed.reason);
  return outcome.kind === 'retry' && now - mtimeMs > maxPendingMs ? outcomeFor(EXPIRED) : outcome;
}
