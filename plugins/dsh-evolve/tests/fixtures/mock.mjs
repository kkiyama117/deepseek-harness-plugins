/** Test-only model adapter. No credentials, network, global monkey-patches, or real providers. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const inject = ['llm'];
export function apply(ctx) {
  let calls = 0;
  class Adapter extends LlmAdapter {
    async listModels() { return [{ provider: 'evolve-mock', id: 'fixed', name: 'Fixture' }]; }
    async *stream(options) {
      calls++;
      const all = options.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      const proposal = all.includes('"assets":');
      const text = proposal ? JSON.stringify({ asset: 'evolve-fixture', description: 'Returns the required answer', content: 'NEW FIXTURE BODY: Always answer GOOD.' })
        : all.includes('NEW FIXTURE BODY') ? 'GOOD' : 'BAD';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['evolve-mock'], new Adapter());
  ctx.provide('evolveFixture', { calls: () => calls });
}
