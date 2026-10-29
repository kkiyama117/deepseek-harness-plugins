#!/usr/bin/env -S uv run --script
"""Validate the skill-explorer hotfix in a temporary copy, without changing the installation."""
from pathlib import Path
import shutil
import subprocess
import tempfile

package = Path("/home/kiyama/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-skill-explorer")
patch = Path(__file__).with_name("skill-explorer-0.3.22-auth.patch").resolve()
subprocess.run(["patch", "--fuzz=0", "--dry-run", "-p1", "-i", str(patch)], cwd=package, check=True)
with tempfile.TemporaryDirectory(prefix="skill-explorer-auth-") as directory:
    root = Path(directory)
    (root / "lib").mkdir()
    shutil.copyfile(package / "lib/index.js", root / "lib/index.js")
    subprocess.run(["patch", "--fuzz=0", "-p1", "-i", str(patch)], cwd=root, check=True)
    subprocess.run(["node", "--check", str(root / "lib/index.js")], check=True)
    subprocess.run(
        ["node", "--input-type=module", "-", str(package / "lib/index.js"), str(root / "lib/index.js")],
        input=r'''
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function guard(file) {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('//#region src/loopback.ts');
  const end = source.indexOf('//#region src/frontmatter.ts');
  return vm.runInNewContext(source.slice(start, end) + '\nisSkillExplorerAllowed');
}
const original = guard(process.argv[2]);
const patched = guard(process.argv[3]);
const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'boiled.colobus-powan.ts.net' } };
const context = new Proxy({ get() { return undefined; } }, {
  get(target, key) {
    if (key in target) return target[key];
    throw new Error(`cannot get property "${key}" without inject`);
  },
});
assert.throws(() => original(context, request), /remoteWebUiPairing/);
let calls = 0;
for (const rejection of [undefined, 401, 403]) {
  for (const host of ['127.0.0.1:3080', 'boiled.colobus-powan.ts.net']) {
    request.headers.host = host;
    const ctx = { connection: { requestRejection(actual) {
      assert.equal(actual, request);
      calls++;
      return rejection;
    } } };
    assert.equal(patched(ctx, request), rejection === undefined);
  }
}
assert.equal(calls, 6);
const source = readFileSync(process.argv[3], 'utf8');
const inject = vm.runInNewContext(source.match(/const inject = \[[\s\S]*?\];/)[0] + '\ninject');
assert.ok(inject.includes('connection'));
console.log('PASS: legacy remote-host exception reproduced; patched guard delegates all six authentication cases; connection dependency declared.');
''',
        text=True,
        check=True,
    )
print("Installed plugin unchanged; no service restart performed.")
