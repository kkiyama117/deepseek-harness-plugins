/** Observe failures and expose human-controlled, fixture-tested skill revisions. */
import { z } from 'zod';
import { Config, EvolveError, initialState, stateSchema } from './schema.mjs';
import { EvolveStore } from './state.mjs';
import { EvolveEngine, SKILL_PROVIDER } from './engine.mjs';
import { TrialRunner } from './runner.mjs';

export { Config };
export const name = 'local-evolve';
export const inject = ['storageDomain', 'skills', 'tools', 'commands', 'agentPresets'];
const inspectionSchema = z.strictObject({ section: z.enum(['status', 'candidates', 'candidate', 'history']), id: z.string().optional() });
const copy = {
  ja: { title: 'スキル改善', command: '改善候補を確認し、人間の操作で承認・却下・復元します。',
    tool: '改善の状態・候補・変更履歴を読み取ります。候補の適用や承認は行いません。',
    hint: 'status | candidates | show <id> | approve <id> <digest> | reject <id> <digest> | rollback <asset> <revision> | cycle',
    failed: '操作できませんでした。状態を再確認してください。', storage: '保存状態が不明なため変更を停止しています。再起動前にストレージを確認してください。',
    large: '表示上限を超えました。候補IDを指定するかinspectionMaxBytesを調整してください。' },
  en: { title: 'Skill improvement', command: 'Inspect proposals and approve, reject, or roll back skills through human commands.',
    tool: 'Read improvement status, candidates, or history. Does not apply or approve changes.',
    hint: 'status | candidates | show <id> | approve <id> <digest> | reject <id> <digest> | rollback <asset> <revision> | cycle',
    failed: 'The operation failed. Inspect the current state before retrying.', storage: 'Writes are stopped because storage state is uncertain. Inspect storage before restarting.',
    large: 'The inspection exceeds its limit. Select a candidate id or adjust inspectionMaxBytes.' },
};

/** Open the sole durable owner before publishing any command, tool, or skill. */
export async function apply(ctx, rawConfig) {
  const config = Config.parse(rawConfig);
  const words = copy[config.locale];
  const domain = await ctx.storageDomain.open({ name: 'local_evolve', version: 1,
    global: { schema: stateSchema, initial: initialState() }, tables: {} });
  const store = new EvolveStore(domain.global, config);
  let runner;
  let engine;
  let providerControl;
  const removers = [];
  let providerDisposer;
  // This effect is registered before dependent contributions, and drains work before storage closes.
  ctx.effect(() => async () => {
    for (const remove of removers.reverse()) await remove();
    await engine?.close();
    await store.close();
    await providerDisposer?.();
    await domain.close();
  }, 'evolve.lifecycle');

  const candidateFor = (asset, revision) => ({ name: asset, description: revision.description,
    source: 'runtime', provider: SKILL_PROVIDER, rank: Number.MAX_SAFE_INTEGER, locator: revision.id,
    resourceBase: { kind: 'opaque', description: 'Human-approved DSH Evolve skill revision.' },
    invocation: { modelInvocable: true, userInvocable: true } });
  providerDisposer = ctx.skills.registerProvider(control => {
    providerControl = control;
    return { name: SKILL_PROVIDER,
      list: async () => {
        if (store.failure) throw new EvolveError('STORAGE_FAILED', words.storage);
        const state = store.read();
        return config.assets.flatMap(asset => {
          const revision = state.revisions[state.active[asset.name]];
          return revision ? [candidateFor(asset.name, revision)] : [];
        });
      },
      get: async candidate => {
        if (store.failure) throw new EvolveError('STORAGE_FAILED', words.storage);
        const state = store.read();
        const revision = state.revisions[state.active[candidate.name]];
        if (!revision || revision.id !== candidate.locator) return undefined;
        const { rank: _rank, locator: _locator, ...summary } = candidateFor(candidate.name, revision);
        return { ...summary, content: revision.content };
      },
    };
  });
  if (config.mode === 'propose') {
    for (const service of ['agents', 'llm', 'systemPrompt']) {
      if (!ctx.get(service)) throw new EvolveError('SERVICE_MISSING', `propose mode requires ${service}.`);
    }
    runner = new TrialRunner(ctx, store, config);
  }
  engine = new EvolveEngine(ctx, store, config, runner, { invalidate: () => providerControl.invalidate() });
  for (const asset of config.assets) await engine.checkCollision(asset.name, { allowIncomplete: true });
  await engine.initialize();

  const inspect = (section, id) => {
    const state = store.read();
    let value;
    switch (section) {
      case 'status':
        value = { mode: config.mode, running: engine.work !== null, storageUncertain: store.failure !== null,
          budget: state.budget, dailyRequestLimit: config.dailyRequestLimit ?? null, active: state.active,
          candidateCount: Object.keys(state.candidates).length, observations: state.observations.length, lastError: state.lastError };
        break;
      case 'candidates':
        value = Object.values(state.candidates).map(candidate => ({ id: candidate.id, asset: candidate.asset,
          digest: candidate.digest, status: candidate.status, validation: candidate.validation?.kind ?? null }));
        break;
      case 'candidate':
        if (!id || !state.candidates[id]) throw new EvolveError('NOT_FOUND', 'Specify an existing candidate id.');
        value = state.candidates[id];
        break;
      case 'history': value = state.history.slice(-10); break;
      default: throw new EvolveError('INVALID_ARGUMENT', 'Unknown inspection section.');
    }
    if (Buffer.byteLength(JSON.stringify(value)) > config.inspectionMaxBytes) throw new EvolveError('OUTPUT_LIMIT', words.large);
    return value;
  };

  removers.push(ctx.tools.register({ name: 'evolve_inspect', description: words.tool,
    parameters: { type: 'object', properties: {
      section: { type: 'string', enum: ['status', 'candidates', 'candidate', 'history'] },
      id: { type: 'string', description: 'Candidate id, required for section=candidate.' },
    }, required: ['section'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { data: {} }, required: ['data'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async args => {
      const parsed = inspectionSchema.parse(args);
      const result = { data: inspect(parsed.section, parsed.id) };
      if (Buffer.byteLength(JSON.stringify(result)) > config.inspectionMaxBytes) throw new EvolveError('OUTPUT_LIMIT', words.large);
      return result;
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: words.title, kind: 'read', rawInput: args }),
  }));

  removers.push(ctx.commands.register({ name: 'evolve', description: words.command,
    input: { hint: words.hint }, recordInput: true,
    handler: async invocation => {
      try {
        invocation.signal.throwIfAborted();
        const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
        const [verb = 'status', first, second] = parts;
        let result;
        const receipt = { commandId: invocation.commandId, sessionId: invocation.agent.id };
        if (verb === 'status' || verb === 'candidates' || verb === 'history') {
          if (parts.length > 1) throw new EvolveError('INVALID_ARGUMENT', words.hint);
          result = inspect(verb);
        } else if (verb === 'show' && parts.length === 2) result = inspect('candidate', first);
        else if (verb === 'cycle' && parts.length === 1) result = await engine.cycle(invocation.agent, invocation.signal);
        else if (parts.length === 3 && first && second) {
          if (verb === 'approve') result = { applied: await engine.approve(first, second, receipt) };
          else if (verb === 'rollback') { await engine.rollback(first, second, receipt); result = { restored: first }; }
          else if (verb === 'reject') { await engine.reject(first, second, receipt); result = { rejected: first }; }
          else throw new EvolveError('INVALID_ARGUMENT', words.hint);
        } else throw new EvolveError('INVALID_ARGUMENT', words.hint);
        return { kind: 'success', text: JSON.stringify(result, null, 2) };
      } catch (error) {
        const code = error instanceof EvolveError ? error.code : 'OPERATION_FAILED';
        ctx.logger.warn(`[evolve] human command failed: ${code}`);
        return { kind: 'error', text: `${words.failed} [${code}] ${store.failure ? words.storage : words.hint}` };
      }
    },
  }));
  removers.push(ctx.on('tools/result', (exec, result) => {
    void engine.observe(exec, result).catch(error => {
      const code = error instanceof EvolveError ? error.code : 'OBSERVATION_FAILED';
      ctx.logger.error(`[evolve] ${code}: ${store.failure ? words.storage : words.failed}`);
    });
  }));
  removers.push(ctx.on('agent/disposed', ({ agent }) => engine.repeat.delete(agent.id)));
}
