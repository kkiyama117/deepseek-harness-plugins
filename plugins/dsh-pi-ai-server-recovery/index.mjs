/** Classify pi-ai failures that report a 5xx status only as text as server errors. */
export const name = 'pi-ai-server-recovery';
export const inject = ['llm'];

export const STATUS_TEXT = /\b(?:internal server error|bad gateway|service unavailable|servers are currently overloaded)\b/i;

export async function* classifyStream(chunks) {
  for await (const chunk of chunks) {
    if (chunk.type === 'finish'
      && chunk.reason?.kind === 'error'
      && chunk.reason.failure?.code === 'PI_AI_ERROR'
      && typeof chunk.reason.failure.message === 'string'
      && STATUS_TEXT.test(chunk.reason.failure.message)) {
      yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, code: 'SERVER' } } };
    } else {
      yield chunk;
    }
  }
}

export function apply(ctx) {
  ctx.on('llm/stream', (options, next) => classifyStream(next()));
}
