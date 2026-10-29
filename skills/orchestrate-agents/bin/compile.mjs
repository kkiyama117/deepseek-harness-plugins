#!/usr/bin/env node
// Offline artifact generator. It never launches an agent or a DSH application.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileWorkflow, fingerprint } from '../scripts/compile.mjs';

const [requestFile, policyFile, outputDirectory, ...extra] = process.argv.slice(2);
if (!requestFile || !policyFile || !outputDirectory || extra.length) {
  console.error('Usage: node bin/compile.mjs REQUEST.json POLICY.json NEW_OUTPUT_DIRECTORY');
  process.exitCode = 2;
} else {
  const request = JSON.parse(await readFile(requestFile, 'utf8'));
  const policy = JSON.parse(await readFile(policyFile, 'utf8'));
  const toolInput = compileWorkflow(request, policy);
  const directory = resolve(outputDirectory);
  // An exclusive directory prevents overwriting accepted plans or run artifacts.
  await mkdir(directory, { mode: 0o700 });
  const save = (name, value) => writeFile(resolve(directory, name), value, { mode: 0o600, flag: 'wx' });
  await save('tool-input.json', JSON.stringify(toolInput, null, 2) + '\n');
  await save('workflow.js', toolInput.script);
  await save('args.json', JSON.stringify(toolInput.args, null, 2) + '\n');
  await save('manifest.json', JSON.stringify({ version: 1, flow: request.flow, toolInputSha256: fingerprint(toolInput), requestFile: resolve(requestFile), policyFile: resolve(policyFile) }, null, 2) + '\n');
  console.log(JSON.stringify({ directory, toolInputSha256: fingerprint(toolInput), submitted: false }));
}
