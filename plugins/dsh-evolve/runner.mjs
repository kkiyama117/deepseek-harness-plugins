/** Fresh, logged, single-request agent runs with execution-time denial and durable reservations. */
import { randomUUID } from 'node:crypto';
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { EvolveError } from './schema.mjs';

/** Own every trial until its agent has drained and been disposed. */
export class TrialRunner {
  constructor(ctx, store, config) {
    this.ctx = ctx;
    this.agents = ctx.get('agents');
    this.store = store;
    this.config = config;
    this.sessions = new Map();
    this.pending = new Set();
    this.controller = new AbortController();
    this.closed = false;
    this.removeStream = ctx.on('llm/stream', (options, next) => {
      const run = this.sessions.get(options.sessionId);
      return run ? this.boundedStream(run, options, next) : next();
    });
  }

  /** Enforce limits immediately before a model adapter is called, including retried calls. */
  async *boundedStream(run, options, next) {
    // Reject auxiliary calls without invalidating the separately owned evaluation request.
    if (!isAgentLoopRequest(options) || options.purpose !== undefined) {
      throw new EvolveError('AUXILIARY_REQUEST', 'Auxiliary model requests are disabled for evaluation sessions.');
    }
    try {
      if (options.provider !== this.config.route.provider || options.model !== this.config.route.model) {
        throw new EvolveError('MODEL_CHANGED', 'The evaluation model route changed.');
      }
      if (run.requests !== 0) {
        throw new EvolveError('REQUEST_LIMIT', 'Each evaluation permits exactly one model request.');
      }
      if (options.maxTokens !== this.config.request.maxOutputTokens) {
        throw new EvolveError('TOKEN_LIMIT_CHANGED', 'The configured output-token limit changed.');
      }
      const bytes = Buffer.byteLength(JSON.stringify({ ...options, signal: undefined }));
      if (bytes > this.config.request.maxInputBytes) {
        throw new EvolveError('INPUT_LIMIT', 'The complete model input exceeds the byte limit.');
      }
      run.signal.throwIfAborted();
      // Claim synchronously before the reservation yields; concurrent calls cannot both enter.
      run.requests++;
      await this.store.reserveRequest();
      run.signal.throwIfAborted();
      let outputBytes = 0;
      for await (const chunk of next()) {
        run.signal.throwIfAborted();
        outputBytes += Buffer.byteLength(JSON.stringify(chunk));
        if (outputBytes > this.config.request.maxOutputBytes) {
          throw new EvolveError('OUTPUT_LIMIT', 'The normalized response stream exceeds the byte limit.');
        }
        if (chunk.type === 'tool-call-delta'
          || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) {
          throw new EvolveError('TOOL_REQUESTED', 'The evaluation requested a tool. No tool was executed.');
        }
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
          throw new EvolveError('MODEL_INCOMPLETE', `The model ended with ${chunk.reason.kind}.`);
        }
        yield chunk;
      }
    } catch (error) {
      run.error = error;
      throw error;
    }
  }

  /** Run one fresh Session; the returned text is from its sole completed turn, not idle status. */
  run({ prompt, instructions, parentAgent, signal }) {
    if (this.closed) return Promise.reject(new EvolveError('CLOSED', 'The trial runner is closed.'));
    const task = this.execute({ prompt, instructions, parentAgent, signal })
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
    return task;
  }

  async execute({ prompt, instructions, parentAgent, signal }) {
    const sessionId = randomUUID();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new EvolveError('TIMEOUT', 'The evaluation deadline expired.')),
      this.config.request.timeoutMs);
    const joined = AbortSignal.any([this.controller.signal, timeout.signal, ...(signal ? [signal] : [])]);
    const run = { signal: joined, requests: 0, steps: 0, error: null };
    this.sessions.set(sessionId, run);
    let handle;
    let removeEvent;
    let onAbort;
    try {
      joined.throwIfAborted();
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      let assistant = null;
      handle = await this.agents.create({
        sessionId,
        ...(parentAgent ? { parentAgent } : {}),
        meta: { origin: 'subagent', agentPreset: 'evolve-trial',
          ...(parentAgent ? { parentSession: parentAgent.id } : {}) },
        agentOptions: { ...this.config.route, maxTokens: this.config.request.maxOutputTokens },
        signal: joined,
        setup: async (agentCtx, agent) => {
          const presets = agentCtx.get('agentPresets');
          if (!presets) throw new EvolveError('SERVICE_MISSING', 'Evaluation requires the agent-presets service.');
          await presets.mount(agentCtx, 'evolve-trial');
          agent.session.append('agent-preset/selected', { agentPreset: 'evolve-trial' });
          agentCtx.tools.guard(() => 'DSH Evolve trials cannot execute tools.');
          agentCtx.systemPrompt.suppressRuntimeContext();
          agentCtx.systemPrompt.section({ name: 'evolve-trial', order: 0, complete: true,
            text: instructions, interpolate: false });
          agentCtx.on('agent/pre-step', (payload, next) => {
            if (payload.modelSelection.provider !== this.config.route.provider
              || payload.modelSelection.model !== this.config.route.model) {
              run.error = new EvolveError('MODEL_CHANGED', 'The selected evaluation route changed.');
              return Promise.resolve({ kind: 'reject' });
            }
            if (run.steps++ !== 0) return Promise.resolve({ kind: 'reject' });
            return next();
          });
          removeEvent = agentCtx.on('session/event', (session, event) => {
            if (session.id !== agent.id) return;
            if (event.type === 'tool/call') run.error = new EvolveError('TOOL_REQUESTED', 'Tools are prohibited in trials.');
            if (event.type === 'assistant/message') {
              assistant = event.data;
              if (assistant.interrupted) run.error = new EvolveError('INTERRUPTED', 'The response was interrupted.');
            }
            if (event.type === 'turn/end') finish(event.data.reason);
          });
        },
      });
      joined.throwIfAborted();
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(joined.reason);
        joined.addEventListener('abort', onAbort, { once: true });
        if (joined.aborted) onAbort();
      });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      const reason = await Promise.race([completed, aborted]);
      joined.throwIfAborted();
      if (run.error) throw run.error;
      if (reason.kind !== 'completed' || assistant === null || run.requests !== 1) {
        throw new EvolveError('TRIAL_INCOMPLETE', 'The sole evaluation turn did not complete with an answer.');
      }
      const source = assistant.message.source;
      if (source.provider !== this.config.route.provider || source.model !== this.config.route.model) {
        throw new EvolveError('MODEL_CHANGED', 'The recorded response route does not match the selected model.');
      }
      const text = assistant.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      return { sessionId, text, usage: assistant.usage ?? null };
    } finally {
      clearTimeout(timer);
      if (onAbort) joined.removeEventListener('abort', onAbort);
      // Keep the stream policy until the driver has drained; late calls remain rejected.
      try {
        if (handle) await handle.dispose();
      } finally {
        removeEvent?.();
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Cancel admitted work and retain its policies until every owned agent is quiescent. */
  async close() {
    this.closed = true;
    this.controller.abort(new EvolveError('CLOSED', 'The plugin is stopping.'));
    await Promise.allSettled([...this.pending]);
    this.removeStream();
  }
}
