import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const SEARCH_BYTES = 16 * 1024;
export const READ_BYTES = 64 * 1024;
const fixedError = code => new Error(`INTAKE_${code}`);

export function resolveConfig(config) {
  const keys = ['aistoreExecutable', 'storeRoot', 'scopeFile'];
  if (!config || Object.keys(config).some(key => !keys.includes(key)) ||
      keys.some(key => typeof config[key] !== 'string' || !isAbsolute(config[key]) || config[key].includes('\0'))) {
    throw fixedError('INVALID_CONFIG');
  }
  return Object.freeze(Object.fromEntries(keys.map(key => [key, config[key]])));
}

export function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw fixedError('INVALID_REQUEST');
  const allowed = request.action === 'search'
    ? ['action', 'query', 'category', 'medium', 'limit', 'include_obsolete']
    : request.action === 'read' ? ['action', 'identity', 'material_version', 'offset'] : [];
  if (!allowed.length || Object.keys(request).some(key => !allowed.includes(key))) throw fixedError('INVALID_REQUEST');
  if (request.action === 'search') {
    if (typeof request.query !== 'string' || !request.query.trim() || [...request.query].length > 500 ||
        (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 10)) ||
        (request.include_obsolete !== undefined && typeof request.include_obsolete !== 'boolean') ||
        ['category', 'medium'].some(key => request[key] !== undefined && (typeof request[key] !== 'string' || Buffer.byteLength(request[key]) > 128))) {
      throw fixedError('INVALID_REQUEST');
    }
  } else if (typeof request.identity !== 'string' || !request.identity || Buffer.byteLength(request.identity) > 4096 ||
      typeof request.material_version !== 'string' || !/^[a-f0-9]{64}$/.test(request.material_version) ||
      (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0))) {
    throw fixedError('INVALID_REQUEST');
  }
}

// Fixed argv, empty credential environment, bounded output, and quiescent cancellation.
// timeoutMs is test-only: the plugin always uses the 15-second default.
export function callKnowledge(config, request, signal, timeoutMs = 15000) {
  const spec = resolveConfig(config);
  validateRequest(request);
  if (signal?.aborted) return Promise.reject(fixedError('CANCELLED'));
  const maxBytes = request.action === 'search' ? SEARCH_BYTES : READ_BYTES;
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 64 * 1024) return Promise.reject(fixedError('INVALID_REQUEST'));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.aistoreExecutable,
      ['--store', spec.storeRoot, '--json', 'knowledge', '--scope', spec.scopeFile],
      { env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const chunks = [];
    let bytes = 0;
    let stderrBytes = 0;
    let failure;
    let forceTimer;
    const kill = sig => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) {
        if (error.code !== 'ESRCH') failure ??= fixedError('PROCESS_TERMINATION_FAILED');
      }
    };
    const fail = code => {
      if (failure) return;
      failure = fixedError(code);
      kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 250);
    };
    const onAbort = () => fail('CANCELLED');
    const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on('error', () => fail('START_FAILED'));
    child.stdin.on('error', () => fail('INPUT_FAILED'));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail('OUTPUT_TOO_LARGE');
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4096) fail('DIAGNOSTIC_TOO_LARGE');
      // Never include raw stderr (paths, credentials, source bodies) in an error.
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      // Kill any descendant in the dedicated group even after its leader exits.
      kill('SIGKILL');
      if (failure) return reject(failure);
      if (code !== 0) return reject(fixedError('CLI_FAILED'));
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(fixedError('INVALID_RESPONSE')); }
      if (result?.protocol_version !== 1 || !result.result || typeof result.result.ok !== 'boolean') {
        return reject(fixedError('INVALID_RESPONSE'));
      }
      if (!result.result.ok) {
        const message = result.result.error;
        return reject(new Error(typeof message === 'string' && /^KNOWLEDGE_[A-Z_]{1,80}$/.test(message)
          ? message : 'INTAKE_OPERATION_FAILED'));
      }
      if (!result.result.value || typeof result.result.value !== 'object' || Array.isArray(result.result.value)) {
        return reject(fixedError('INVALID_RESPONSE'));
      }
      resolve(result.result.value);
    });
    child.stdin.end(input);
  });
}
