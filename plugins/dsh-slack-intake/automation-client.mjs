/** stdin JSON bridge to Go's external management state; never supplies network credentials. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rename, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class AutomationError extends Error {
  constructor(code, detail = '') { super(detail || code); this.name = 'AutomationError'; this.code = code; }
}
function decode(text) {
  const value = JSON.parse(text);
  if (value.protocol_version !== 1 || typeof value.result?.ok !== 'boolean') throw new AutomationError('INVALID_PROTOCOL');
  if (!value.result.ok) throw new AutomationError('OPERATION_REJECTED', value.result.error);
  return value.result.value;
}
export function callManagement(config, request, { operation = 'automation', signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.aistoreExecutable, ['--store', config.storeRoot, '--json', operation, '--state-home', config.stateHome], { env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    const chunks = []; let bytes = 0; let overflow = false;
    const abort = () => child.kill('SIGKILL');
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { overflow = true; abort(); } else chunks.push(chunk); });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new AutomationError('PROCESS_START_FAILED')));
    child.once('close', (code, killed) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (overflow || killed || code !== 0) return reject(new AutomationError('PROCESS_FAILED'));
      try { resolve(decode(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error instanceof AutomationError ? error : new AutomationError('INVALID_PROTOCOL')); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
export async function acquireWorkerLock(config, signal) {
  if (signal.aborted) throw new AutomationError('INTERRUPTED');
  const child = spawn(config.aistoreExecutable, ['--store', config.storeRoot, '--json', 'automation', 'lock', '--state-home', config.stateHome], { env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  let text = ''; let readyResolve; let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stdout.on('data', chunk => {
    text += chunk.toString('utf8');
    if (text.length > 4096) { readyReject(new AutomationError('LOCK_PROTOCOL')); child.kill('SIGKILL'); }
    else if (text.includes('\n')) { try { if (decode(text).ready !== true) throw new Error(); readyResolve(); } catch { readyReject(new AutomationError('LOCK_UNAVAILABLE')); } }
  });
  child.stdin.on('error', () => {});
  child.once('error', () => readyReject(new AutomationError('LOCK_UNAVAILABLE')));
  let released = false;
  const done = new Promise(resolve => child.once('close', () => { readyReject(new AutomationError('LOCK_UNAVAILABLE')); resolve(); }));
  const abort = () => child.kill('SIGKILL');
  const timer = setTimeout(abort, 15000);
  signal.addEventListener('abort', abort, { once: true });
  try { await ready; } catch (error) { abort(); await done; throw error; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  const lost = done.then(() => { if (!released) throw new AutomationError('LOCK_LOST'); });
  void lost.catch(() => {});
  return { lost, async release() { released = true; child.stdin.end(); await done; } };
}
export async function atomicJSON(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
