import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('real headless profile composes the bundle and enforces the human-controlled loop', { timeout: 120000 }, async (t) => {
  const root = process.env.DSH_HOST_ROOT;
  assert.ok(root && isAbsolute(root), 'Set DSH_HOST_ROOT to the built, reviewed DSH checkout');
  const { runLoaderSmoke } = await import(pathToFileURL(join(root, 'packages/test-support/loader-smoke/lib/index.js')));
  const driver = fileURLToPath(new URL('./fixtures/composition-driver.mjs', import.meta.url));
  const patch = fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url));
  const result = await runLoaderSmoke({ label: 'dsh-evolve', mode: 'lib', tempDirPrefix: 'dsh-evolve-composition-',
    binScript: driver, libBinScript: driver, configPath: patch, tsconfigPath: join(root, 'tsconfig.json'),
    processTimeoutMs: 90000, env: { DSH_HOST_ROOT: root } });
  const estimate = JSON.parse(result.stdout.split('\n').find(line => line.includes('"type":"tool-schema-estimate"')));
  assert.ok(estimate.afterTokens > estimate.beforeTokens);
  t.diagnostic(`Tool-schema-only first-request estimate: ${estimate.beforeTokens} -> ${estimate.afterTokens} tokens (host heuristic, not provider usage)`);
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(summary, { loader: true, pairedTrials: 1, noAutoApply: true,
    humanCommand: true, exactRollback: true, requestBudget: 3, disposal: true });
});
