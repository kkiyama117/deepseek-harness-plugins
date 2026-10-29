#!/usr/bin/env node
// Opt-in classification/artifact generator; never submits a workflow or runs agents.
import { open, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { routeStage } from '../scripts/route.mjs';

const [stageFile, policyFile, outputDirectory, previousFile, ...extra] = process.argv.slice(2);
if (!stageFile || !policyFile || !outputDirectory || extra.length) {
  console.error('Usage: node bin/route.mjs STAGE.json ROUTING_POLICY.json NEW_PRIVATE_DIRECTORY [PREVIOUS_REPORT.json]');
  process.exitCode = 2;
} else {
  const readJson = async path => {
    const file = await open(path, 'r');
    try {
      if ((await file.stat()).size > 4 * 1024 * 1024) throw new Error('input-too-large');
      return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  };
  try {
    const stage = await readJson(stageFile), policy = await readJson(policyFile);
    const previous = previousFile ? await readJson(previousFile) : null;
    const directory = resolve(outputDirectory);
    await mkdir(directory, { mode: 0o700 });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    const save = (name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    let report, requestSaved = false;
    try { report = await routeStage(stage, policy, { previous, signal: controller.signal, onRequest: async request => {
      await save('classification-request.json', request); requestSaved = true;
    } }); }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    await save('report.json', report);
    if (report.request && !requestSaved) await save('classification-request.json', report.request);
    if (report.response) await save('classification-response.json', report.response);
    if (report.executable) {
      await save('routed-request.json', report.routedRequest);
      await save('tool-input.json', report.toolInput);
    }
    console.log(JSON.stringify({ directory, status: report.status, executable: report.executable, submitted: false, reason: report.reason }));
    if (['fallback', 'hold'].includes(report.status)) process.exitCode = 1;
  } catch {
    // File contents, HTTP failures and credentials must never be printed as diagnostics.
    console.error('Routing input/artifact error: check JSON, input size and a new private output directory.');
    process.exitCode = 2;
  }
}
