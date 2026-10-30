/** Classify incomplete Codex normal-close and service-restart failures as transport errors. */
export const name = 'codex-transport-recovery';
export const inject = ['llm'];

export async function* classifyStream(chunks, provider) {
  for await (const chunk of chunks) {
    if (provider === 'openai-codex' && chunk.type === 'finish'
      && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'PI_AI_ERROR'
      && /^WebSocket closed (?:1000|1012)(?:\s.*)?$/.test(chunk.reason.failure.message)) {
      yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, code: 'TRANSPORT' } } };
    } else {
      yield chunk;
    }
  }
}

export function apply(ctx) {
  ctx.on('llm/stream', (options, next) => classifyStream(next(), options.provider));
}
