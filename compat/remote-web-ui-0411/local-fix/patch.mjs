/**
 * Apply the two reviewed local fixes onto a pristine npm 0.4.11 copy, or
 * verify that an already-patched copy carries exactly them.
 *
 * Fix A — bootstrap pairing policy: the Host publishes
 * `__DSH_REMOTE_PAIRING_POLICY__` ahead of every script row, so the browser
 * half knows the steady-state pairing gate at first paint instead of
 * installing the gated channel provisionally and then retiring it.
 *
 * Fix B — retired-channel lifetime: one `installRemoteChannel` generation
 * cannot notify, rewrite, or uninstall after its restore.
 *
 * Authentication, pairing, gating and route code are untouched.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only these literal substitutions are authorized for upstream 0.4.11. */
export const patches = {
  'src/index.ts': [
    [
      "    const value = resolve()\n    if (!value.enabled || !value.requirePairingForLan) return\n    table.push({ kind: 'script', placement: 'head', text: REMOTE_CHANNEL_BOOT_SCRIPT })",
      "    const value = resolve()\n    table.push({ kind: 'global', name: '__DSH_REMOTE_PAIRING_POLICY__', value: value.enabled && value.requirePairingForLan })\n    if (!value.enabled || !value.requirePairingForLan) return\n    table.push({ kind: 'script', placement: 'head', text: REMOTE_CHANNEL_BOOT_SCRIPT })",
    ],
  ],
  'lib/types/index.js': [
    [
      '        const value = resolve();\n        if (!value.enabled || !value.requirePairingForLan)\n            return;',
      "        const value = resolve();\n        table.push({ kind: 'global', name: '__DSH_REMOTE_PAIRING_POLICY__', value: value.enabled && value.requirePairingForLan });\n        if (!value.enabled || !value.requirePairingForLan)\n            return;",
    ],
  ],
  'lib/index.js': [
    [
      '\t\tconst value = resolve();\n\t\tif (!value.enabled || !value.requirePairingForLan) return;',
      '\t\tconst value = resolve();\n\t\ttable.push({ kind: "global", name: "__DSH_REMOTE_PAIRING_POLICY__", value: value.enabled && value.requirePairingForLan });\n\t\tif (!value.enabled || !value.requirePairingForLan) return;',
    ],
  ],
  'src/client/index.ts': [
    [
      '  let disposeChannel: (() => void) | undefined\n  let hostPairingPolicy: boolean | undefined',
      '  let disposeChannel: (() => void) | undefined\n  const bootPairingPolicy = (window as unknown as Record<string, unknown>).__DSH_REMOTE_PAIRING_POLICY__\n  let hostPairingPolicy: boolean | undefined = typeof bootPairingPolicy === \'boolean\' ? bootPairingPolicy : undefined',
    ],
  ],
  'lib/types/client/index.js': [
    [
      '    let disposeChannel;\n    let hostPairingPolicy;',
      "    let disposeChannel;\n    const bootPairingPolicy = window.__DSH_REMOTE_PAIRING_POLICY__;\n    let hostPairingPolicy = typeof bootPairingPolicy === 'boolean' ? bootPairingPolicy : undefined;",
    ],
  ],
  'src/client/remote-channel.ts': [
    [
      'export function installRemoteChannel(window: ChannelWindow, options: RemoteChannelOptions = {}): () => void {\n  const originalFetch = window.fetch',
      'export function installRemoteChannel(window: ChannelWindow, options: RemoteChannelOptions = {}): () => void {\n  let active = true\n  const originalFetch = window.fetch',
    ],
    [
      '  const rewrite = (raw: string): string => rewriteRawUrl(raw, window.location.href, window.location.origin)',
      '  const rewrite = (raw: string): string => active ? rewriteRawUrl(raw, window.location.href, window.location.origin) : raw',
    ],
    [
      '  const patchedFetch: typeof globalThis.fetch = (input, init) => {',
      '  const patchedFetch: typeof globalThis.fetch = (input, init) => {\n    if (!active) return originalFetch.call(window, input, init)',
    ],
    [
      '      return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {',
      '      return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {\n        if (!active) return response',
    ],
    [
      '        if (response.status === 403 && await isUnpairedDenied(response.clone())) options.onUnpaired?.()\n        else options.onPaired?.()',
      '        const denied = response.status === 403 && await isUnpairedDenied(response.clone())\n        if (!active) return response\n        if (denied) options.onUnpaired?.()\n        else options.onPaired?.()',
    ],
    [
      "      if (wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {",
      "      if (active && wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {",
    ],
    [
      '        if (sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
      '        if (active && sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
    ],
    [
      '  return () => {\n    window.fetch = originalFetch',
      '  return () => {\n    if (!active) return\n    active = false\n    window.fetch = originalFetch',
    ],
  ],
  'lib/types/client/remote-channel.js': [
    [
      'export function installRemoteChannel(window, options = {}) {\n    const originalFetch = window.fetch;',
      'export function installRemoteChannel(window, options = {}) {\n    let active = true;\n    const originalFetch = window.fetch;',
    ],
    [
      '    const rewrite = (raw) => rewriteRawUrl(raw, window.location.href, window.location.origin);',
      '    const rewrite = (raw) => active ? rewriteRawUrl(raw, window.location.href, window.location.origin) : raw;',
    ],
    [
      '    const patchedFetch = (input, init) => {',
      '    const patchedFetch = (input, init) => {\n        if (!active)\n            return originalFetch.call(window, input, init);',
    ],
    [
      '            return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {',
      '            return Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {\n                if (!active)\n                    return response;',
    ],
    [
      '                if (response.status === 403 && await isUnpairedDenied(response.clone()))\n                    options.onUnpaired?.();\n                else\n                    options.onPaired?.();',
      '                const denied = response.status === 403 && await isUnpairedDenied(response.clone());\n                if (!active)\n                    return response;\n                if (denied)\n                    options.onUnpaired?.();\n                else\n                    options.onPaired?.();',
    ],
    [
      "            if (wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {",
      "            if (active && wsOrigin !== '' && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {",
    ],
    [
      '                if (sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
      '                if (active && sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
    ],
    [
      '    return () => {\n        window.fetch = originalFetch;',
      '    return () => {\n        if (!active)\n            return;\n        active = false;\n        window.fetch = originalFetch;',
    ],
  ],
  'lib/client.js': [
    [
      '\t\t\tlet disposeChannel;\n\t\t\tlet hostPairingPolicy;',
      '\t\t\tlet disposeChannel;\n\t\t\tconst bootPairingPolicy = window.__DSH_REMOTE_PAIRING_POLICY__;\n\t\t\tlet hostPairingPolicy = typeof bootPairingPolicy === "boolean" ? bootPairingPolicy : void 0;',
    ],
    [
      '\t\tfunction installRemoteChannel(window, options = {}) {\n\t\t\tconst originalFetch = window.fetch;',
      '\t\tfunction installRemoteChannel(window, options = {}) {\n\t\t\tlet active = true;\n\t\t\tconst originalFetch = window.fetch;',
    ],
    [
      '\t\t\tconst rewrite = (raw) => rewriteRawUrl(raw, window.location.href, window.location.origin);',
      '\t\t\tconst rewrite = (raw) => active ? rewriteRawUrl(raw, window.location.href, window.location.origin) : raw;',
    ],
    [
      '\t\t\tconst patchedFetch = (input, init) => {',
      '\t\t\tconst patchedFetch = (input, init) => {\n\t\t\t\tif (!active) return originalFetch.call(window, input, init);',
    ],
    [
      '\t\t\t\t\treturn Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {',
      '\t\t\t\t\treturn Promise.resolve(originalFetch.call(window, next, attach(init))).then(async (response) => {\n\t\t\t\t\t\tif (!active) return response;',
    ],
    [
      '\t\t\t\t\t\tif (response.status === 403 && await isUnpairedDenied(response.clone())) options.onUnpaired?.();\n\t\t\t\t\t\telse options.onPaired?.();',
      '\t\t\t\t\t\tconst denied = response.status === 403 && await isUnpairedDenied(response.clone());\n\t\t\t\t\t\tif (!active) return response;\n\t\t\t\t\t\tif (denied) options.onUnpaired?.();\n\t\t\t\t\t\telse options.onPaired?.();',
    ],
    [
      '\t\t\t\t\tif (wsOrigin !== "" && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {',
      '\t\t\t\t\tif (active && wsOrigin !== "" && wsOrigin === window.location.origin && shouldRewriteWsPath(parsed.pathname)) {',
    ],
    [
      '\t\t\t\t\t\tif (sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
      '\t\t\t\t\t\tif (active && sameOrigin(parsed) && shouldRewriteFetchPath(parsed.pathname)) {',
    ],
    [
      '\t\t\treturn () => {\n\t\t\t\twindow.fetch = originalFetch;',
      '\t\t\treturn () => {\n\t\t\t\tif (!active) return;\n\t\t\t\tactive = false;\n\t\t\t\twindow.fetch = originalFetch;',
    ],
  ],
  'package.json': [
    ['"version": "0.4.11"', '"version": "0.4.11-local.1"'],
    [
      '    "cordis.patch.yml",\n    "icon.svg"\n  ],',
      '    "cordis.patch.yml",\n    "icon.svg",\n    "UPGRADE.json",\n    "local-fix"\n  ],',
    ],
  ],
};

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashes = JSON.parse(readFileSync(new URL('./base-sha256.json', import.meta.url), 'utf8'));
const [mode, target = fileURLToPath(new URL('..', import.meta.url))] = process.argv.slice(2);
assert.ok(mode === '--apply' || mode === '--verify', 'usage: node local-fix/patch.mjs --apply|--verify [package directory]');
const root = resolve(target);
const changed = new Map();
for (const [file, expected] of Object.entries(hashes)) {
  const bytes = readFileSync(`${root}/${file}`);
  const text = bytes.toString('utf8');
  const operations = patches[file];
  if (operations === undefined) {
    // Untouched payload: --apply requires the pristine bytes, --verify forbids
    // any change the authorized list does not name.
    assert.equal(hash(bytes), expected, `${file}: changed outside the authorized patch`);
    continue;
  }
  if (mode === '--apply') {
    assert.equal(hash(bytes), expected, `${file}: base SHA-256 mismatch; refusing all writes`);
    let patched = text;
    for (const [before, after] of operations) {
      assert.equal(patched.split(before).length - 1, 1, `${file}: exact base snippet must match once: ${JSON.stringify(before)}`);
      patched = patched.replace(before, after);
    }
    changed.set(file, patched);
  } else {
    for (const [before, after] of operations) {
      assert.equal(text.split(after).length - 1, 1, `${file}: exact patched snippet must match once: ${JSON.stringify(after)}`);
      // An insertion keeps its anchor verbatim, so only a rewritten snippet can
      // prove the base text is gone.
      if (!after.includes(before)) assert.ok(!text.includes(before), `${file}: base snippet still present: ${JSON.stringify(before)}`);
    }
  }
}
if (mode === '--apply') for (const [file, text] of changed) writeFileSync(`${root}/${file}`, text);
console.log(JSON.stringify({ mode, root, changed: [...changed.keys()] }));
