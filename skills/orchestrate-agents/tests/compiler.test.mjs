import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileWorkflow, fingerprint } from '../scripts/compile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async name => JSON.parse(await readFile(join(root, 'examples', name + '.json'), 'utf8'));

test('same request and policy produce identical payload and hash; task strings are data', async () => {
  const request = await json('single'), policy = await json('policy');
  const first = compileWorkflow(request, policy);
  assert.deepEqual(first, compileWorkflow(request, policy));
  assert.equal(fingerprint(first), fingerprint(compileWorkflow(request, policy)));
  request.task.context = '`; throw new Error("injected"); //';
  const second = compileWorkflow(request, policy);
  assert.equal(second.script, first.script);
  assert.notEqual(fingerprint(second), fingerprint(first));
  assert(!second.script.includes('injected'));
  assert.equal(first.args.request.task.context, (await json('single')).task.context);
});

test('generated plain-JS body runs with only the documented args and agent hook', async () => {
  const payload = compileWorkflow(await json('lead-workers'), await json('policy'));
  const calls = [];
  const context = vm.createContext({ args: payload.args, agent: async (prompt, opts) => {
    calls.push({ prompt, opts });
    assert.equal(opts.schema.type, 'object');
    assert.deepEqual(Object.keys(opts).sort(), ['label', 'model', 'phase', 'provider', 'schema']);
    return { status: 'done', summary: 'Synthetic node done', evidence: ['Synthetic acceptance evidence'] };
  } });
  const result = await new vm.Script(`(async () => {${payload.script}})()`).runInContext(context);
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 5);
  assert.equal(calls[0].opts.model, payload.args.policy.roles.lead.model);
  assert.equal(calls[1].opts.model, payload.args.policy.roles.worker.model);
  assert(calls.every(c => !c.opts.effort && !c.opts.reasoning_effort));
});

test('offline compiler saves private artifacts and refuses to overwrite a run directory', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'orchestrate-compiler-'));
  try {
    const output = join(temporary, 'run');
    const args = [join(root, 'bin/compile.mjs'), join(root, 'examples/single.json'), join(root, 'examples/policy.json'), output];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const payload = JSON.parse(await readFile(join(output, 'tool-input.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.toolInputSha256, fingerprint(payload));
    assert.equal(await readFile(join(output, 'workflow.js'), 'utf8'), payload.script);
    if (process.platform !== 'win32') {
      assert.equal((await stat(output)).mode & 0o777, 0o700);
      assert.equal((await stat(join(output, 'tool-input.json'))).mode & 0o777, 0o600);
    }
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /EEXIST/);
    assert.equal(await readFile(join(output, 'tool-input.json'), 'utf8'), JSON.stringify(payload, null, 2) + '\n');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('example requests compile and no unsupported reasoning option is silently accepted', async () => {
  const policy = await json('policy');
  for (const name of ['single', 'lead-workers', 'coordinator-advisor', 'custom']) compileWorkflow(await json(name), policy);
  const request = await json('single');
  policy.roles.executor.effort = 'high';
  assert.throws(() => compileWorkflow(request, policy), /fields must be provider, model/);
});
