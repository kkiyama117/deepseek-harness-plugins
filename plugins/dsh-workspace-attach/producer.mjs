/** Ask the running web host to attach each new headless Session to a workspace. */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serializeHint, workspaceSpecFromEnv } from './hints.mjs';

export const name = 'local-workspace-attach-producer';
export const inject = [];

const DEFAULT_HINT_ROOT = join(homedir(), '.dsh', 'workspace-attach-hints');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const isSubagent = session => session.header.parentSession !== undefined || session.header.origin === 'subagent';

/**
 * Write one hint unless the session already has a hint or rejection record.
 * @param hintRoot - Hint directory.
 * @param hint - Hint to publish.
 * @returns resolution once the hint is visible under its final name.
 */
async function writeHint(hintRoot, hint) {
  const target = join(hintRoot, `${hint.sessionId}.json`);
  if (await exists(target) || await exists(join(hintRoot, `${hint.sessionId}.rejected.json`))) return;
  await mkdir(hintRoot, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, serializeHint(hint));
  await rename(temporary, target);
}

/**
 * Mount the hint producer when `DSH_WORKSPACE_ID` asks for a workspace.
 * @param ctx - Host context.
 * @param config - Plugin config.
 */
export function apply(ctx, config) {
  const hintRoot = config?.hintRoot ?? DEFAULT_HINT_ROOT;
  if (typeof hintRoot !== 'string' || hintRoot === '') {
    throw new TypeError('local-workspace-attach-producer: hintRoot must be a non-empty string');
  }
  const workspace = workspaceSpecFromEnv(process.env.DSH_WORKSPACE_ID);
  if (workspace === undefined) return;
  ctx.on('session/created', (session) => {
    if (isSubagent(session)) return;
    return writeHint(hintRoot, { sessionId: session.id, workspace }).catch((error) => {
      const message = `local-workspace-attach-producer: cannot write a hint for session '${session.id}': ${String(error)}`;
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message);
      else console.warn(message);
    });
  });
}
