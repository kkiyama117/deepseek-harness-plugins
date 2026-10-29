#!/usr/bin/env node
// Explicit one-request smoke with synthetic data; no workflow or agent is executed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { routeStage } from '../scripts/route.mjs';

const [flag, outputDirectory, model = 'typesafe/jev-1.13', ...extra] = process.argv.slice(2);
if (flag !== '--live' || !outputDirectory || extra.length || !['typesafe/jev-1.13', '~typesafe/jev-latest'].includes(model) || !process.env.OPENROUTER_API_KEY) {
  console.error('Usage: OPENROUTER_API_KEY from environment; node bin/smoke-openrouter.mjs --live NEW_PRIVATE_DIRECTORY [typesafe/jev-1.13|~typesafe/jev-latest]');
  process.exitCode = 2;
} else {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { mode: 0o700 });
  const save = (name, data) => writeFile(resolve(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const policy = JSON.parse(await readFile(new URL('../examples/routing-policy.json', import.meta.url), 'utf8'));
  Object.assign(policy, { gateway: 'openrouter', model, externalSend: true, facts: {}, workflowAuthorized: false, mode: 'shadow' });
  Object.assign(policy.limits, { maxCalls: 1, maxInputBytes: 16000, maxRequestBytes: 16000, maxResponseBytes: 16000, timeoutMs: 30000 });
  const stage = {
    version: 1, requestId: 'synthetic-translation', stageId: 'translate', sourceRevision: 'fixture-v1', remainingGoals: ['Translate the supplied sentence'],
    task: {
      originalRequest: 'Translate the sentence Hello, world! into Japanese. Return only the translation.',
      goal: 'Return a Japanese translation of the supplied English sentence.',
      context: 'The complete text is supplied; no external facts, research, tools or file changes are needed.',
      acceptance: ['Preserve the greeting meaning in natural Japanese.'], constraints: ['Text answer only. No tools or delegation.'], writeScope: [],
    },
    units: [], dependencies: {}, division: 'none', routineCandidates: [], investigation: null,
  };
  const start = performance.now();
  const observeFetch = async (url, options) => {
    const response = await fetch(url, options);
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > policy.limits.maxResponseBytes) throw new Error('oversized-smoke-response');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const body = Buffer.concat(chunks).toString('utf8').replaceAll(process.env.OPENROUTER_API_KEY, '[REDACTED]');
    await save('api-receipt.json', { httpStatus: response.status, body });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const report = await routeStage(stage, policy, { fetchImpl: observeFetch, onRequest: request => save('request.json', request) });
  await save('report.json', report);
  let cacheVerified = false;
  if (report.status === 'shadow' && report.response) {
    const cached = await routeStage(stage, { ...policy, externalSend: false }, { previous: report, fetchImpl: () => { throw new Error('unexpected smoke retry'); } });
    cacheVerified = model === '~typesafe/jev-latest'
      ? cached.cacheHit !== true && cached.usage.calls === 1 && cached.reason === 'external-send-not-authorized'
      : cached.cacheHit === true && cached.usage.calls === 1 && cached.status === 'shadow';
    await save('cached-report.json', cached);
  }
  const summary = {
    gateway: report.gateway, requestedModel: policy.model, returnedModel: report.response?.model ?? null,
    upstreamProvider: report.response?.provider ?? null, requestId: report.requestId ?? null,
    status: report.status, flow: report.flow, reason: report.reason,
    elapsedMs: Math.round(performance.now() - start), calls: report.usage.calls,
    usage: report.response?.usage ?? null, answers: report.response?.answers ?? null,
    cacheVerified, cachePolicy: report.cachePolicy, executable: report.executable, submitted: false,
  };
  await save('summary.json', summary);
  console.log(JSON.stringify({ directory, ...summary }));
  if (report.status !== 'shadow' || report.flow !== 'F1' || !cacheVerified) process.exitCode = 1;
}
