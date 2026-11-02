/** Attach headless-created Sessions to a workspace through the hint-file handoff. */
import { watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseHint, processHint } from './hints.mjs';

export const name = 'local-workspace-attach';
export const inject = ['workspaceRegistry'];

const DEFAULT_HINT_ROOT = join(homedir(), '.dsh', 'workspace-attach-hints');

const DEBOUNCE_MS = 200;

/**
 * Validate the plugin config at the boundary.
 * @param config - Raw config from the composition row.
 * @returns the resolved config.
 */
function resolveConfig(config) {
  const hintRoot = config?.hintRoot ?? DEFAULT_HINT_ROOT;
  if (typeof hintRoot !== 'string' || hintRoot === '') {
    throw new TypeError('local-workspace-attach: hintRoot must be a non-empty string');
  }
  const scanIntervalMs = config?.scanIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs <= 0) {
    throw new TypeError('local-workspace-attach: scanIntervalMs must be a positive integer');
  }
  const maxPendingMs = config?.maxPendingMs ?? 600_000;
  if (!Number.isSafeInteger(maxPendingMs) || maxPendingMs <= 0) {
    throw new TypeError('local-workspace-attach: maxPendingMs must be a positive integer');
  }
  return { hintRoot, scanIntervalMs, maxPendingMs };
}

/**
 * Read one Session's cwd from the public persistence service the workspace
 * registry itself uses. Absent or unreadable storage means "not ready yet".
 * @param ctx - Host context.
 * @returns the cwd reader used for `kind: 'cwd'` hints.
 */
export function sessionCwdReader(ctx) {
  return async (sessionId) => {
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined) return undefined;
    const snapshot = await persistence.stat(sessionId).catch(() => undefined);
    return snapshot?.header.cwd;
  };
}

async function removeQuietly(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function rejectHint({ hintRoot, fileName, text, reason, now }) {
  const target = join(hintRoot, `${fileName.slice(0, -'.json'.length)}.rejected.json`);
  try {
    await rename(join(hintRoot, fileName), target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const parsed = parseHint(fileName, text);
  await writeFile(target, JSON.stringify({ hint: parsed.ok ? parsed.hint : text, reason, at: new Date(now).toISOString() }));
}

async function processHintFile({ hintRoot, fileName, registry, readSessionCwd, maxPendingMs, now }) {
  const path = join(hintRoot, fileName);
  let text;
  let info;
  try {
    [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile()) return;
  const outcome = await processHint({
    fileName, text, mtimeMs: info.mtimeMs, now, registry, maxPendingMs, readSessionCwd,
  });
  if (outcome.kind === 'attached') await removeQuietly(path);
  else if (outcome.kind === 'rejected') await rejectHint({ hintRoot, fileName, text, reason: outcome.reason, now });
}

/**
 * Process every pending hint once, sequentially.
 * @param input - Hint root, registry, cwd reader, and expiry window.
 * @returns resolution after the last hint; never rejects.
 */
export async function scanOnce({ hintRoot, registry, readSessionCwd, maxPendingMs, now = Date.now(), log = console.warn }) {
  let names;
  try {
    names = await readdir(hintRoot);
  } catch (error) {
    log(`local-workspace-attach: cannot list ${hintRoot}: ${String(error)}`);
    return;
  }
  for (const fileName of names) {
    if (!fileName.endsWith('.json') || fileName.endsWith('.rejected.json') || fileName.endsWith('.tmp')) continue;
    try {
      await processHintFile({ hintRoot, fileName, registry, readSessionCwd, maxPendingMs, now });
    } catch (error) {
      // One unreadable or unwritable hint must not stop the rest of the scan.
      log(`local-workspace-attach: cannot process ${fileName}: ${String(error)}`);
    }
  }
}

/**
 * Mount the workspace hint consumer for the web host.
 * @param ctx - Host context carrying `workspaceRegistry`.
 * @param config - Plugin config.
 * @returns resolution after the hint root exists and the first scan ran.
 */
export async function apply(ctx, config) {
  const settings = resolveConfig(config);
  const registry = ctx.workspaceRegistry;
  const readSessionCwd = sessionCwdReader(ctx);
  const log = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message);
    else console.warn(message);
  };
  const scan = () => scanOnce({ ...settings, registry, readSessionCwd, log });
  let tail = Promise.resolve();
  let debounce;
  let watcher;
  let timer;
  let disposed = false;
  const rescan = () => {
    if (disposed) return;
    tail = tail.then(scan);
  };

  // Cordis refuses an effect on a disposed fiber, so the teardown is registered before the first await.
  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(debounce);
    clearInterval(timer);
    watcher?.close();
  }, 'workspace-attach: hint watcher');

  await mkdir(settings.hintRoot, { recursive: true, mode: 0o700 });
  if (disposed) return;
  await scan();
  if (disposed) return;

  try {
    watcher = watch(settings.hintRoot, () => {
      clearTimeout(debounce);
      debounce = setTimeout(rescan, DEBOUNCE_MS);
    });
    watcher.on('error', error => log(`local-workspace-attach: hint watcher failed: ${String(error)}`));
    watcher.unref();
  } catch (error) {
    log(`local-workspace-attach: cannot watch ${settings.hintRoot}: ${String(error)}`);
  }
  // The scan must never keep a one-shot process alive after its work is done.
  timer = setInterval(rescan, settings.scanIntervalMs).unref();
}
