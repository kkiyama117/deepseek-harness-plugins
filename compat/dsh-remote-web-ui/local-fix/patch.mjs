import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only these literal substitutions are authorized for upstream 0.4.4.
const patches = {
  'src/index.ts': [
    ["    const value = resolve()\n    if (!value.enabled || !value.requirePairingForLan) return\n    table.push({ kind: 'script', placement: 'head', text: REMOTE_CHANNEL_BOOT_SCRIPT })",
      "    const value = resolve()\n    table.push({ kind: 'global', name: '__DSH_REMOTE_PAIRING_POLICY__', value: value.enabled && value.requirePairingForLan })\n    if (!value.enabled || !value.requirePairingForLan) return\n    table.push({ kind: 'script', placement: 'head', text: REMOTE_CHANNEL_BOOT_SCRIPT })"],
  ],
  'lib/types/index.js': [
    ["        const value = resolve();\n        if (!value.enabled || !value.requirePairingForLan)\n            return;\n        table.push({ kind: 'script', placement: 'head', text: REMOTE_CHANNEL_BOOT_SCRIPT });",
      "        const value = resolve();\n        table.push({ kind: 'global', name: '__DSH_REMOTE_PAIRING_POLICY__', value: value.enabled && value.requirePairingForLan });\n        if (!value.enabled || !value.requirePairingForLan)\n            return;\n        table.push({ kind: 'script', placement: 'head', text: REMOTE_CHANNEL_BOOT_SCRIPT });"],
  ],
  'lib/index.js': [
    ['\t\tconst value = resolve();\n\t\tif (!value.enabled || !value.requirePairingForLan) return;',
      '\t\tconst value = resolve();\n\t\ttable.push({ kind: "global", name: "__DSH_REMOTE_PAIRING_POLICY__", value: value.enabled && value.requirePairingForLan });\n\t\tif (!value.enabled || !value.requirePairingForLan) return;'],
  ],
  'src/client/index.ts': [
    ['  let hostPairingPolicy: boolean | undefined',
      "  const bootPairingPolicy = (window as unknown as Record<string, unknown>).__DSH_REMOTE_PAIRING_POLICY__\n  let hostPairingPolicy: boolean | undefined = typeof bootPairingPolicy === 'boolean' ? bootPairingPolicy : undefined"],
  ],
  'lib/types/client/index.js': [
    ['    let hostPairingPolicy;',
      "    const bootPairingPolicy = window.__DSH_REMOTE_PAIRING_POLICY__;\n    let hostPairingPolicy = typeof bootPairingPolicy === 'boolean' ? bootPairingPolicy : undefined;"],
  ],
  'src/client/remote-channel.ts': [
    ['export function installRemoteChannel(window: ChannelWindow, options: RemoteChannelOptions = {}): () => void {',
      'export function installRemoteChannel(window: ChannelWindow, options: RemoteChannelOptions = {}): () => void {\n  let active = true'],
    ['const rewrite = (raw: string): string => rewriteRawUrl(raw, window.location.href, window.location.origin)',
      'const rewrite = (raw: string): string => active ? rewriteRawUrl(raw, window.location.href, window.location.origin) : raw'],
    ['const patchedFetch: typeof globalThis.fetch = (input, init) => {',
      'const patchedFetch: typeof globalThis.fetch = (input, init) => {\n    if (!active) return originalFetch.call(window, input, init)'],
    ['return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {',
      'return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {\n        if (!active) return response'],
    ['if (response.status === 403 && await isUnpairedDenied(response.clone())) options.onUnpaired?.()',
      'const denied = response.status === 403 && await isUnpairedDenied(response.clone())\n        if (!active) return response\n        if (denied) options.onUnpaired?.()'],
    ["if (wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {",
      "if (active && wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {"],
    ['if (sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
      'if (active && sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {'],
    ['return () => {\n    window.fetch = originalFetch',
      'return () => {\n    if (!active) return\n    active = false\n    window.fetch = originalFetch'],
  ],
  'lib/types/client/remote-channel.js': [
    ['export function installRemoteChannel(window, options = {}) {',
      'export function installRemoteChannel(window, options = {}) {\n    let active = true;'],
    ['const rewrite = (raw) => rewriteRawUrl(raw, window.location.href, window.location.origin);',
      'const rewrite = (raw) => active ? rewriteRawUrl(raw, window.location.href, window.location.origin) : raw;'],
    ['const patchedFetch = (input, init) => {',
      'const patchedFetch = (input, init) => {\n        if (!active)\n            return originalFetch.call(window, input, init);'],
    ['return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {',
      'return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {\n                if (!active)\n                    return response;'],
    ['if (response.status === 403 && await isUnpairedDenied(response.clone()))\n                    options.onUnpaired?.();',
      'const denied = response.status === 403 && await isUnpairedDenied(response.clone());\n                if (!active)\n                    return response;\n                if (denied)\n                    options.onUnpaired?.();'],
    ["if (wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {",
      "if (active && wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {"],
    ['if (sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
      'if (active && sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {'],
    ['return () => {\n        window.fetch = originalFetch;',
      'return () => {\n        if (!active)\n            return;\n        active = false;\n        window.fetch = originalFetch;'],
  ],
  'lib/client.js': [
    ['\t\t\tlet hostPairingPolicy;',
      '\t\t\tconst bootPairingPolicy = window.__DSH_REMOTE_PAIRING_POLICY__;\n\t\t\tlet hostPairingPolicy = typeof bootPairingPolicy === "boolean" ? bootPairingPolicy : void 0;'],
    ['function installRemoteChannel(window, options = {}) {',
      'function installRemoteChannel(window, options = {}) {\n\t\t\tlet active = true;'],
    ['const rewrite = (raw) => rewriteRawUrl(raw, window.location.href, window.location.origin);',
      'const rewrite = (raw) => active ? rewriteRawUrl(raw, window.location.href, window.location.origin) : raw;'],
    ['const patchedFetch = (input, init) => {',
      'const patchedFetch = (input, init) => {\n\t\t\t\tif (!active) return originalFetch.call(window, input, init);'],
    ['return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {',
      'return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {\n\t\t\t\t\t\tif (!active) return response;'],
    ['if (response.status === 403 && await isUnpairedDenied(response.clone())) options.onUnpaired?.();',
      'const denied = response.status === 403 && await isUnpairedDenied(response.clone());\n\t\t\t\t\t\tif (!active) return response;\n\t\t\t\t\t\tif (denied) options.onUnpaired?.();'],
    ['if (wsOrigin !== "" && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {',
      'if (active && wsOrigin !== "" && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {'],
    ['if (sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
      'if (active && sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {'],
    ['return () => {\n\t\t\t\twindow.fetch = originalFetch;',
      'return () => {\n\t\t\t\tif (!active) return;\n\t\t\t\tactive = false;\n\t\t\t\twindow.fetch = originalFetch;'],
    ['\n\n//# sourceMappingURL=client.js.map', '\n'],
  ],
  'package.json': [
    ['"version": "0.4.4"', '"version": "0.4.4-local.2"'],
    ['    "icon.svg"\n  ],', '    "icon.svg",\n    "LOCAL-FIX.md",\n    "local-fix/*.mjs",\n    "local-fix/*.json",\n    "local-fix/*.tap"\n  ],'],
  ],
};

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashes = JSON.parse(readFileSync(new URL('./base-sha256.json', import.meta.url), 'utf8'));
const [mode, target = fileURLToPath(new URL('..', import.meta.url))] = process.argv.slice(2);
assert.ok(mode === '--apply' || mode === '--verify', 'usage: node local-fix/patch.mjs --apply|--verify [package directory]');
const root = resolve(target);
const changed = new Map();
for (const [file, expected] of Object.entries(hashes)) {
  const originalBytes = readFileSync(`${root}/${file}`);
  let text = originalBytes.toString('utf8');
  const operations = patches[file];
  if (mode === '--apply') {
    assert.equal(hash(originalBytes), expected, `${file}: original SHA-256 mismatch; refusing all writes`);
    if (!operations) continue;
    for (const [before, after] of operations) {
      assert.equal(text.split(before).length - 1, 1, `${file}: exact base snippet must match once: ${JSON.stringify(before)}`);
      text = text.replace(before, after);
    }
    changed.set(file, text);
  } else {
    if (operations) {
      for (const [before, after] of operations.toReversed()) {
        if (file === 'lib/client.js' && before.includes('sourceMappingURL')) {
          assert.ok(text.endsWith('\n') && !text.includes('sourceMappingURL'), `${file}: stale source map reference`);
          text = text.slice(0, -1) + before;
        } else {
          assert.equal(text.split(after).length - 1, 1, `${file}: exact patched snippet must match once`);
          text = text.replace(after, before);
        }
      }
    }
    assert.equal(hash(operations ? text : originalBytes), expected, `${file}: bytes differ beyond the limited patch`);
  }
}
if (mode === '--apply') {
  for (const [file, text] of changed) writeFileSync(`${root}/${file}`, text);
}
console.log(`${mode}: verified ${Object.keys(hashes).length} original files; only ${Object.keys(patches).join(', ')} may differ`);
console.log(`Base Host lib/index.js SHA-256: ${hashes['lib/index.js']}`);
console.log(`Current Host lib/index.js SHA-256: ${hash(readFileSync(`${root}/lib/index.js`))}`);
console.log('Host differences are limited to the bootstrap-policy global injection; all other Host bytes and auth/gating modules are unchanged.');
