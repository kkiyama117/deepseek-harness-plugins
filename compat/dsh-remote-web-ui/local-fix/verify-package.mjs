import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}/package.json`));
const archivePath = resolve(process.argv[2] ?? `${root}/linxin666-dsh-remote-web-ui-${manifest.version}.tgz`);
const archive = readFileSync(archivePath);
const tar = gunzipSync(archive);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const field = (block, start, length) => block.subarray(start, start + length).toString().split('\0')[0];
const entries = new Map();
for (let offset = 0; offset + 512 <= tar.length;) {
  const block = tar.subarray(offset, offset + 512);
  if (block.every((byte) => byte === 0)) break;
  const prefix = field(block, 345, 155);
  const name = (prefix ? `${prefix}/` : '') + field(block, 0, 100);
  const size = parseInt(field(block, 124, 12).trim(), 8) || 0;
  const type = field(block, 156, 1);
  offset += 512;
  if (type === '0' || type === '') {
    assert.ok(name.startsWith('package/') && !name.includes('..'));
    const relative = name.slice(8);
    assert.ok(!entries.has(relative));
    const bytes = tar.subarray(offset, offset + size);
    assert.equal(hash(bytes), hash(readFileSync(`${root}/${relative}`)), `packed bytes: ${relative}`);
    entries.set(relative, bytes);
  } else assert.equal(type, '5', `unexpected tar entry type: ${type}`);
  offset += Math.ceil(size / 512) * 512;
}
const base = JSON.parse(readFileSync(`${root}/local-fix/base-sha256.json`));
const expected = [...Object.keys(base), 'LOCAL-FIX.md', ...readdirSync(`${root}/local-fix`)
  .filter((name) => /\.(mjs|json|tap)$/.test(name)).map((name) => `local-fix/${name}`)];
assert.deepEqual([...entries.keys()].sort(), expected.sort());
const packed = JSON.parse(entries.get('package.json'));
assert.equal(packed.name, '@linxin666/dsh-remote-web-ui');
assert.equal(packed.version, manifest.version);
assert.equal(packed.license, 'Apache-2.0');
console.log(`Tarball: ${archivePath}`);
console.log(`Tarball SHA-256: ${hash(archive)}`);
console.log(`Verified ${entries.size} packed files against workspace; all ${Object.keys(base).length} base resources included.`);
console.log(`Packed Host SHA-256: ${hash(entries.get('lib/index.js'))}`);
