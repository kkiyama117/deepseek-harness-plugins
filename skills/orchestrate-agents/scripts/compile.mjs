import { createHash } from 'node:crypto';
import { createFlowRuntime } from './runtime.mjs';
import { createComparisonRuntime } from './comparison.mjs';

/** Construct native DSH tool input without interpolating task data into executable code. */
export function compileWorkflow(request, policy) {
  if (request.flow === 'comparison') {
    const prepared = createComparisonRuntime(createFlowRuntime()).prepare({ request, policy });
    return {
      meta: { name: 'orchestrate-comparison', description: 'Read-only single-model and conditional-advisor comparison', phases: [{ title: 'single' }, { title: 'executor-advisor' }] },
      script: `${createFlowRuntime.toString()}\n${createComparisonRuntime.toString()}\nreturn await createComparisonRuntime(createFlowRuntime()).run(args, { agent });\n`,
      args: { request: prepared.request, policy: prepared.policy },
      resultKeys: ['status', 'callsStarted', 'summary'],
    };
  }
  const args = createFlowRuntime().prepare({ request, policy });
  const script = `${createFlowRuntime.toString()}\nreturn await createFlowRuntime().run(args, { agent });\n`;
  return {
    meta: { name: `orchestrate-${request.flow}`, description: `Validated ${request.flow} orchestration`, phases: [{ title: request.flow }] },
    script,
    args,
    resultKeys: ['status', 'callsStarted', 'summary'],
  };
}

/** Hash the exact compiled tool payload retained with its run receipt. */
export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
