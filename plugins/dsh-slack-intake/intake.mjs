/** One-shot aistore commands; credential values never reach argv, output, or return values. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/** @typedef {{aistoreExecutable: string, storeRoot: string}} Config */
/** @typedef {import('@deepseek-ai/dsh-credentials').CredentialProvider} Credentials */
/** @typedef {import('@deepseek-ai/dsh-credentials').CredentialRef} CredentialRef */
/** @typedef {{stdout: {write(text: string): unknown}, stderr: {write(text: string): unknown}}} IO */

const TOKEN_FILE_LIMIT = 16 * 1024;
const STDOUT_LIMIT = 8_000_000;
const STDERR_LIMIT = 1024;
const SLACK_CONDITIONS = new Set([
  'invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive',
  'missing_scope', 'not_in_channel', 'channel_not_found', 'is_archived', 'ratelimited',
  'invalid_arguments', 'access_denied', 'org_login_required', 'team_access_not_granted',
  'fatal_error', 'internal_error', 'unrecognized_error', 'http-status', 'retry-limit',
  'retry-header', 'invalid-response', 'byte-limit', 'page-limit', 'repeated-cursor',
  'cursor-missing', 'invalid-pagination', 'invalid-message', 'window',
  'limited-without-anchor', 'anchor-missing', 'credential-in-response',
]);

/** Return only an allowlisted condition, never arbitrary subprocess stderr. */
function slackDiagnostic(text, secret) {
  if (secret && text.includes(secret)) return undefined;
  const match = /^slack ([a-z_-]+): http [0-9]{3}\n?$/.exec(text);
  if (match && SLACK_CONDITIONS.has(match[1])) return `AISTORE_SLACK_${match[1].replaceAll('-', '_').toUpperCase()}`;
  const fixed = new Map([
    ['slack policy is invalid', 'POLICY_INVALID'],
    ['slack collection input is invalid', 'INPUT_INVALID'],
    ['slack credential is invalid', 'CREDENTIAL_INVALID'],
    ['slack request failed without a response', 'NETWORK_FAILED'],
  ]);
  const code = fixed.get(text.trim());
  return code ? `AISTORE_SLACK_${code}` : undefined;
}
const USAGE = 'credential status | credential import --file ABS_PATH | AISTORE_COMMAND ...';
const EXIT_DIAGNOSTICS = new Map([
  [1, 'AISTORE_OPERATION_FAILED'],
  [2, 'AISTORE_USAGE_ERROR'],
]);

/** Error carrying only an adapter-owned fixed diagnostic code. */
export class AdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AdapterError';
    this.code = code;
  }
}

/**
 * Validate deployment paths and reject legacy Python configuration.
 * @param {Config & Record<string, unknown>} config - Explicit executable and store paths.
 * @returns {Config} Absolute paths used for every invocation.
 */
export function resolveConfig(config) {
  if (!config || Object.hasOwn(config, 'python') || Object.hasOwn(config, 'skillRoot')) {
    throw new Error('aistore-adapter: legacy python and skillRoot configuration is unsupported');
  }
  if (![config.aistoreExecutable, config.storeRoot].every(value =>
    typeof value === 'string' && isAbsolute(value) && !value.includes('\0'))) {
    throw new Error('aistore-adapter: configure absolute aistoreExecutable and storeRoot paths');
  }
  return { aistoreExecutable: config.aistoreExecutable, storeRoot: config.storeRoot };
}

/** Reject unsafe POSIX metadata before reading any bytes. */
export function assertPrivateMetadata(info, uid, directory = false) {
  if (info.uid !== uid || (info.mode & 0o077) !== 0 || (info.mode & 0o7000) !== 0
    || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > TOKEN_FILE_LIMIT)) {
    throw new AdapterError('CREDENTIAL_FILE_UNSAFE');
  }
}

/** Read one explicitly approved private credential file. */
async function readCredential(filename) {
  if (typeof filename !== 'string' || !isAbsolute(filename) || filename.includes('\0')) {
    throw new AdapterError('CREDENTIAL_FILE_INVALID');
  }
  if (typeof process.getuid !== 'function' || constants.O_NOFOLLOW === undefined) {
    throw new AdapterError('CREDENTIAL_IMPORT_UNSUPPORTED');
  }
  const path = resolve(filename);
  const parent = dirname(path);
  const uid = process.getuid();
  assertPrivateMetadata(await lstat(parent), uid, true);
  if (await realpath(parent) !== parent) throw new AdapterError('CREDENTIAL_FILE_UNSAFE');
  const before = await lstat(path);
  assertPrivateMetadata(before, uid);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    assertPrivateMetadata(opened, uid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new AdapterError('CREDENTIAL_FILE_CHANGED');
    const bytes = Buffer.alloc(TOKEN_FILE_LIMIT + 1);
    try {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      assertPrivateMetadata(after, uid);
      if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs) throw new AdapterError('CREDENTIAL_FILE_CHANGED');
      const value = bytes.subarray(0, bytesRead).toString('utf8').trim();
      if (!/^[\x21-\x7e]+$/.test(value)) throw new AdapterError('CREDENTIAL_FILE_INVALID');
      return value;
    } finally {
      bytes.fill(0);
    }
  } finally {
    await handle.close();
  }
}

function parseEnvelope(text, secret) {
  if (secret && text.includes(secret)) throw new AdapterError('AISTORE_SECRET_OUTPUT');
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new AdapterError('AISTORE_PROTOCOL_ERROR');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || envelope.protocol_version !== 1 || !Object.hasOwn(envelope, 'result')) {
    throw new AdapterError('AISTORE_PROTOCOL_ERROR');
  }
  return envelope;
}

/**
 * Run one current aistore CLI operation with bounded stdout and an isolated environment.
 * @param {Config} config - Validated executable and store paths.
 * @param {readonly string[]} args - Exact aistore operation after global flags.
 * @param {AbortSignal} signal - Owned cancellation signal.
 * @param {{name: string, value: string}|undefined} credential - Optional child-only credential.
 * @param {typeof spawn} spawnChild - Injectable process adapter.
 * @returns {Promise<{exitCode: 0|3, envelope: {protocol_version: 1, result: unknown}, text: string}>} Successful operation or handoff result.
 */
export async function runAistore(config, args, signal, credential, spawnChild = spawn) {
  if (signal.aborted) throw new AdapterError('AISTORE_INTERRUPTED');
  if (!Array.isArray(args) || args.length === 0 || args.some(value => typeof value !== 'string' || value.includes('\0'))
    || args.includes('--store') || args.includes('--json')) {
    throw new AdapterError('AISTORE_ARGUMENTS_INVALID');
  }
  const env = { LANG: 'C.UTF-8', ...(credential === undefined ? {} : { [credential.name]: credential.value }) };
  let child;
  try {
    child = spawnChild(config.aistoreExecutable, ['--store', config.storeRoot, '--json', ...args], {
      env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new AdapterError('AISTORE_SPAWN_FAILED');
  }
  const chunks = [];
  const diagnosticChunks = [];
  let diagnosticBytes = 0;
  let bytes = 0;
  let failed = false;
  let overflow = false;
  return new Promise((resolveRun, rejectRun) => {
    const abort = () => {
      if (child.pid === undefined) return;
      try { child.kill('SIGKILL'); } catch { failed = true; }
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > STDOUT_LIMIT) {
        chunks.length = 0;
        overflow = true;
        abort();
      } else {
        chunks.push(Buffer.from(chunk));
      }
    });
    child.stderr.on('data', chunk => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes <= STDERR_LIMIT) diagnosticChunks.push(Buffer.from(chunk));
      else diagnosticChunks.length = 0;
    });
    child.once('error', () => { failed = true; });
    child.once('close', (code, childSignal) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return rejectRun(new AdapterError('AISTORE_INTERRUPTED'));
      if (overflow) return rejectRun(new AdapterError('AISTORE_STDOUT_LIMIT'));
      if (failed || childSignal !== null || code === null) return rejectRun(new AdapterError('AISTORE_PROCESS_FAILED'));
      if (code !== 0 && code !== 3) {
        const diagnostic = code === 1 && isSlackCollection(args) && diagnosticBytes <= STDERR_LIMIT
          ? slackDiagnostic(Buffer.concat(diagnosticChunks).toString('utf8'), credential?.value) : undefined;
        return rejectRun(new AdapterError(diagnostic ?? EXIT_DIAGNOSTICS.get(code) ?? 'AISTORE_EXIT_ERROR'));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const envelope = parseEnvelope(text, credential?.value);
        resolveRun({ exitCode: code, envelope, text });
      } catch (error) {
        rejectRun(error);
      }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function isNetworkResume(args) {
  return args[0] === 'intake' && args[1] === 'resume' && args.filter(value => value === '--allow-network').length === 1;
}

function isSlackCollection(args) {
  return args[0] === 'intake' && args[1] === 'slack' && args[2] === 'collect';
}

/** Execute one standalone credential or aistore operation. */
export async function execute({ credentials, refs, args, config, io, signal, spawnChild }) {
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (args[0] === 'credential') {
      if (args.length === 2 && args[1] === 'status') {
        const info = await credentials.describe(refs.openrouter);
        const source = ['env', 'file', 'project-env', 'user-env'].includes(info.source) ? info.source : undefined;
        if (!signal.aborted) io.stdout.write(JSON.stringify({ credential: 'OPENROUTER_API_KEY',
          configured: info.configured === true, writable: info.writable === true,
          ...(source === undefined ? {} : { source }) }) + '\n');
        return signal.aborted ? 1 : 0;
      }
      if (args.length === 4 && args[1] === 'import' && args[2] === '--file') {
        const describe = async () => {
          const info = await credentials.describe(refs.openrouter);
          if (info.configured) throw new AdapterError('CREDENTIAL_ALREADY_CONFIGURED');
          if (!info.writable) throw new AdapterError('CREDENTIAL_NOT_WRITABLE');
        };
        await describe();
        const value = await readCredential(args[3]);
        await describe();
        if (signal.aborted) return 1;
        await credentials.set(refs.openrouter, value);
        const stored = await credentials.resolve(refs.openrouter);
        if (stored?.value !== value) throw new AdapterError('CREDENTIAL_VERIFY_FAILED');
        if (!signal.aborted) io.stdout.write('OPENROUTER_API_KEY imported and verified.\n');
        return signal.aborted ? 1 : 0;
      }
      throw new AdapterError('AISTORE_ARGUMENTS_INVALID');
    }
    let credential;
    if (isNetworkResume(args)) {
      const resolved = await credentials.resolve(refs.openrouter);
      if (!resolved) throw new AdapterError('CREDENTIAL_NOT_CONFIGURED');
      credential = { name: 'OPENROUTER_API_KEY', value: resolved.value };
    } else if (isSlackCollection(args)) {
      const resolved = await credentials.resolve(refs.slack);
      if (!resolved) throw new AdapterError('CREDENTIAL_NOT_CONFIGURED');
      credential = { name: 'SLACK_BOT_TOKEN', value: resolved.value };
    }
    const result = await runAistore(config, args, signal, credential, spawnChild);
    if (!signal.aborted) io.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
    return result.exitCode;
  } catch (error) {
    if (!signal.aborted) io.stderr.write(`aistore-adapter: ${error instanceof AdapterError ? error.code : 'ADAPTER_FAILURE'}\n`);
    return 1;
  }
}
