// subagent-fallback — subagent-call-level provider/model fallback.
//
// Registers one delegation tool (default name `subagent_frontier`, the
// implement-task frontier) that rides on the existing `subagents` registry:
// the same request shape and start path as @deepseek-ai/dsh-tool-subagent,
// plus an ordered fallback chain. A run that ends with stopReason 'error'
// (model or transport failure — the seam's definition, not a task failure)
// is retried against the next route. 'completed' wins; 'aborted',
// 'max-tokens', and 'refusal' are returned as-is without retry.
//
// Load multiple rows for implement-task roles (same plugin, different config):
//   subagent_frontier — planner/reviewer (kimi-k3 → grok-4.6)
//   subagent_worker   — implementation (deepseek-v4-flash → composer-2.5)
//   subagent_verify   — deterministic verify (deepseek-v4-flash)
//
// Config (row config):
//   toolName: subagent_frontier   # optional
//   provider: spawn               # optional
//   primary:                      # required
//     provider: kimi-coding
//     model: kimi-k3
//   fallbackRoutes:               # optional, tried in order
//     - provider: cursor
//       model: grok-4.6
export const name = 'subagent-fallback';
export const inject = ['tools', 'subagents'];

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  ctx.tools.register({
    name: cfg.toolName,
    description: 'Delegate one focused task to a child agent, retrying with fallback provider/model routes when the run fails with a model or transport error. This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
        },
      },
      required: ['description', 'prompt'],
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) return 'error: subagent tool requires a calling agent (exec.agent was undefined)';
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
      };
      if (args.run_in_background) {
        const jobs = ctx.get('jobs');
        if (!jobs) return 'error: background jobs unavailable (load @deepseek-ai/dsh-jobs)';
        const jobId = jobs.start({
          kind: 'subagent',
          label: args.description,
          owner: parent,
          run: () => {
            const controller = new AbortController();
            return {
              cancel: (reason) => controller.abort(reason ?? 'background subagent task killed'),
              done: runWithFallback(ctx, cfg, request, controller.signal),
            };
          },
        });
        return 'background job ' + jobId;
      }
      return runWithFallback(ctx, cfg, request, exec.signal);
    },
  });
}

export function normalizeConfig(config) {
  const cfg = config || {};
  const primary = cfg.primary;
  if (!primary || typeof primary.provider !== 'string' || typeof primary.model !== 'string') {
    throw new Error('subagent-fallback: config.primary needs string provider and model');
  }
  const fallbackRoutes = cfg.fallbackRoutes === undefined ? [] : cfg.fallbackRoutes;
  if (!Array.isArray(fallbackRoutes) || fallbackRoutes.some((route) => !route || typeof route.provider !== 'string' || typeof route.model !== 'string')) {
    throw new Error('subagent-fallback: config.fallbackRoutes must be an array of { provider, model }');
  }
  return {
    toolName: typeof cfg.toolName === 'string' && cfg.toolName ? cfg.toolName : 'subagent_frontier',
    provider: typeof cfg.provider === 'string' && cfg.provider ? cfg.provider : 'spawn',
    primary,
    fallbackRoutes,
  };
}

export async function runWithFallback(ctx, cfg, request, signal) {
  const routes = [cfg.primary, ...cfg.fallbackRoutes];
  const outcome = await fallbackLoop(routes, (route) => runOnce(ctx, cfg.provider, { ...request, agentOptions: route }, signal));
  return renderOutcome(outcome);
}

// The retry policy, separated for testing: attempt(route) returns
// { stopReason, output?, detail? }. Only 'error' retries; the first
// non-error terminal reason is final; all-error returns the last failure.
export async function fallbackLoop(routes, attempt) {
  let last = null;
  for (const route of routes) {
    const result = await attempt(route);
    if (result.stopReason === 'completed') return { ok: true, result };
    if (result.stopReason === 'error') {
      last = result;
      continue;
    }
    return { ok: false, result };
  }
  return { ok: false, result: last };
}

async function runOnce(ctx, provider, request, signal) {
  let run;
  try {
    run = await ctx.subagents.start(provider, { ...request, signal });
  } catch (error) {
    return { stopReason: 'error', detail: String(error && error.message ? error.message : error) };
  }
  try {
    return await run.result;
  } catch (error) {
    return { stopReason: 'error', detail: String(error && error.message ? error.message : error) };
  } finally {
    await run.dispose().catch(() => {});
  }
}

function renderOutcome(outcome) {
  if (outcome.ok) return renderOutput(outcome.result.output);
  const result = outcome.result;
  if (!result) return 'error: all fallback routes failed without a result';
  const partial = renderOutput(result.output || []);
  const detail = result.detail ? ' ' + result.detail : '';
  const head = 'subagent run ' + result.stopReason + detail;
  return partial ? head + '\nPartial output before the run ended:\n' + partial : head;
}

function renderOutput(blocks) {
  return (blocks || [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}
