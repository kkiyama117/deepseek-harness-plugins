import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callKnowledge, resolveConfig, validateRequest } from '../client.mjs';

export async function fakeCLI(t, body) {
  const dir = await mkdtemp(join(tmpdir(), 'intake-knowledge-test-'));
  const executable = join(dir, 'aistore');
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  t.after(async () => { assert.equal(resolve(dir), dir); assert.ok(dir.startsWith(join(tmpdir(), 'intake-knowledge-test-'))); await rm(dir, { recursive: true }); });
  return { dir, config: { aistoreExecutable: executable, storeRoot: dir, scopeFile: join(dir, 'scope.json') } };
}

const input = { action: 'search', query: 'memory' };
test('fixed argv, JSON stdin, and credential-free environment', async t => {
  const { config, dir } = await fakeCLI(t, `
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const request=JSON.parse(Buffer.concat(chunks).toString());
process.stdout.write(JSON.stringify({protocol_version:1,result:{ok:true,value:{argv:process.argv.slice(2),env:process.env,request}}}));`);
  const query = '$(touch SHOULD_NOT_EXIST); "quoted" 日本語';
  const got = await callKnowledge(config, { action: 'search', query });
  assert.deepEqual(got.argv, ['--store', dir, '--json', 'knowledge', '--scope', join(dir, 'scope.json')]);
  assert.deepEqual(got.env, { LANG: 'C.UTF-8' });
  assert.equal(got.request.query, query);
});

test('invalid actions, extra fields, offsets and config fail before spawning', () => {
  for (const r of [{ ...input, command: 'delete' }, { action: 'approve' }, { ...input, limit: 11 },
    { ...input, query: ' ' }, { ...input, query: 'a'.repeat(501) },
    { action: 'read', identity: 'x:1', material_version: 'a'.repeat(64), offset: -1 }]) {
    assert.throws(() => validateRequest(r), /INTAKE_INVALID_REQUEST/);
  }
  assert.throws(() => resolveConfig({ aistoreExecutable: 'relative', storeRoot: '/x', scopeFile: '/x' }), /INVALID_CONFIG/);
  assert.throws(() => resolveConfig({ aistoreExecutable: '/bin/a', storeRoot: '/x', scopeFile: '/x', token: 'secret' }), /INVALID_CONFIG/);
});

test('does not expose raw stderr or unrecognized business errors', async t => {
  for (const body of [
    `process.stderr.write('PRIVATE_TOKEN'); process.exit(1);`,
    `process.stdout.write(JSON.stringify({protocol_version:1,result:{ok:false,error:'PRIVATE_TOKEN'}}));`,
    `process.stdout.write('PRIVATE_BAD_JSON');`,
  ]) {
    const { config } = await fakeCLI(t, body);
    await assert.rejects(callKnowledge(config, input), error => /^INTAKE_/.test(error.message) && !error.message.includes('PRIVATE'));
  }
  const { config } = await fakeCLI(t, `process.stdout.write(JSON.stringify({protocol_version:1,result:{ok:false,error:'KNOWLEDGE_SCOPE_CHANGED'}}));`);
  await assert.rejects(callKnowledge(config, input), /KNOWLEDGE_SCOPE_CHANGED/);
});

test('output cap, timeout, abort and pre-abort terminate the subprocess', async t => {
  const large = await fakeCLI(t, `process.stdout.write('x'.repeat(17000)); setInterval(()=>{},1000);`);
  await assert.rejects(callKnowledge(large.config, input), /OUTPUT_TOO_LARGE/);
  const slow = await fakeCLI(t, `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
  await assert.rejects(callKnowledge(slow.config, input, undefined, 30), /TIMEOUT/);
  const controller = new AbortController();
  const running = callKnowledge(slow.config, input, controller.signal);
  controller.abort();
  await assert.rejects(running, /CANCELLED/);
  await assert.rejects(callKnowledge(slow.config, input, controller.signal), /CANCELLED/);
});
