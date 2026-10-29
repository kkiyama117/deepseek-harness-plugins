import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('installation preserves both old skills outside discovery and repeated installation is a no-op', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orchestrate-install-'));
  try {
    const skills = join(home, '.agents/skills');
    for (const name of ['orchestrate-agents', 'task-router']) {
      await mkdir(join(skills, name), { recursive: true });
      await writeFile(join(skills, name, 'SKILL.md'), `original ${name}\n`);
    }
    const run = () => spawnSync('python3', [join(root, 'bin/install.py')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.preserved.length, 2);
    for (const path of receipt.preserved) {
      assert(path.startsWith(join(home, '.local/state/orchestrate-agents/backups/')));
      const name = path.split('/').at(-1);
      assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), `original ${name}\n`);
    }
    assert.equal(await realpath(join(skills, 'orchestrate-agents')), await realpath(root));
    await assert.rejects(lstat(join(skills, 'task-router')), { code: 'ENOENT' });
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).preserved, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
