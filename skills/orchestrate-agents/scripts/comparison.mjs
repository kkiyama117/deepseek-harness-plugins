/** Fixed three-arm experiment using the ordinary flow runtime, without a model judge. */
export function createComparisonRuntime(flowRuntime) {
  const arms = ['flash', 'astra', 'flash-advisor'];
  function check(ok, message) { if (!ok) throw new Error(message); }
  function keys(value, expected, label) {
    check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k)), `${label}: expected ${expected.join(', ')}`);
  }
  function prepare({ request, policy }) {
    keys(request, ['version', 'flow', 'task', 'order', 'fixtureId'], 'comparison request');
    check(request.version === 1 && request.flow === 'comparison', 'expected comparison version 1');
    check(typeof request.fixtureId === 'string' && request.fixtureId.trim(), 'fixtureId is required');
    check(Array.isArray(request.order) && request.order.length === 3 && new Set(request.order).size === 3 && request.order.every(id => arms.includes(id)), 'order must be a permutation of all three arms');
    keys(policy.roles, ['flash', 'astra'], 'comparison roles');
    check(request.task.writeScope?.length === 0, 'comparison v1 requires read-only tasks; prepare isolated writable fixtures before extending it');
    const prepared = request.order.map(id => {
      const roles = { executor: id === 'astra' ? policy.roles.astra : policy.roles.flash };
      if (id === 'flash-advisor') roles.advisor = policy.roles.astra;
      return { id, input: flowRuntime.prepare({
        request: { version: 1, flow: id === 'flash-advisor' ? 'executor-advisor' : 'single', task: request.task, units: [], batches: [], options: { concurrency: 1, repairRounds: 0 } },
        policy: { ...policy, roles },
      }) };
    });
    const worstCaseCalls = prepared.reduce((sum, arm) => sum + flowRuntime.validateGraph(flowRuntime.buildTemplate(arm.input), arm.input).worstCaseCalls, 0);
    check(worstCaseCalls <= policy.limits.maxCalls, 'comparison total worst-case call budget exceeded');
    return JSON.parse(JSON.stringify({ request, policy, arms: prepared, worstCaseCalls }));
  }
  async function run(input, hooks) {
    const experiment = prepare(input);
    const results = [];
    for (const arm of experiment.arms) {
      // No predecessor output crosses arms. Host exceptions/cancellation abort the experiment.
      const record = await flowRuntime.run(arm.input, { agent: (prompt, options) => hooks.agent(prompt, { ...options, label: `${arm.id}/${options.label}` }) });
      results.push({ id: arm.id, record, measurements: {
        effectiveModel: null, inputTokens: null, outputTokens: null, cost: null, elapsedMs: null,
        independentAcceptance: 'pending',
      } });
    }
    return {
      status: 'awaiting-evaluation', fixtureId: experiment.request.fixtureId,
      callsStarted: results.reduce((sum, arm) => sum + arm.record.callsStarted, 0),
      experiment, results,
      summary: results.map(arm => ({ id: arm.id, status: arm.record.status, callsStarted: arm.record.callsStarted, acceptance: arm.record.summary.acceptance, nonDone: arm.record.summary.nonDone })),
      note: 'All arms were attempted, not independently accepted. Join host telemetry and fixed-rubric evaluation before comparing quality or cost. Null measurements are unknown, not zero. Read-only scopes are instructions, not sandbox isolation.',
    };
  }
  return { prepare, run };
}
