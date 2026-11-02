/** Agent-side tool entry for native reader/reviewer tasks; it has no credential access. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveNativeConfig, runNativeTask } from './native.mjs';

/** Stable agent-side plugin name. */
export const name = 'aistore-native-task';
/** The tool consumes the host registries already mounted for an Agent session. */
export const inject = ['tools', 'subagents', 'sessionQuery'];

/** Register one native task tool in an Agent-owned scope. */
export function apply(ctx, config) {
  const spec = resolveNativeConfig(config);
  ctx.tools.register(defineTool({
    name: 'aistore_native_task',
    description: 'Claim and execute one pending aistore reader or reviewer task. Use only task_id and input_hash from a handoff; the adapter owns the private claim and receipt.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Exact pending task_id from aistore.' },
      inputHash: { type: 'string', required: true, description: 'Exact input_hash bound to that task.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', const: 'accepted', required: true },
          taskId: { type: 'string', required: true },
          attempt: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `Native task accepted (attempt ${value.attempt}).` }];
      },
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('aistore-native: an executing Agent is required');
      return runNativeTask({ config: spec, taskId: args.taskId, inputHash: args.inputHash,
        parent: exec.agent, signal: exec.signal, subagents: ctx.subagents, sessionQuery: ctx.sessionQuery });
    },
  }));
}
