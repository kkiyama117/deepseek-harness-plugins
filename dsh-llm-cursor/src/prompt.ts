/**
 * `GenerateOptions` → Cursor agent prompt text. The Cursor SDK `send` takes
 * one user message, so the harness conversation is flattened to text: a
 * fresh agent receives the system prompt and full history, a resumed agent
 * only the latest user message (it already holds the conversation).
 *
 * @module dsh-llm-cursor/prompt
 */

import type { ContentBlock, GenerateOptions, Message, TextBlock } from '@deepseek-ai/dsh-llm'

/** Join the text of a block list; non-text blocks contribute nothing. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Render one message's content blocks as prompt text. Reasoning blocks are
 * model-internal and skipped; tool calls and results render as a transcript
 * so a fresh Cursor agent sees what the harness did before it.
 * @param message - one harness message.
 * @returns the message's prompt text.
 */
export function renderMessage(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        // Reasoning is model-internal; it is not input to any provider.
        break
      case 'tool-call':
        parts.push(`[tool call ${block.name}(${block.arguments})]`)
        break
      case 'tool-result':
        parts.push(`[tool result: ${textOf(block.content)}]`)
        break
      default:
        // Merge-extensible block types carry no prompt rendering here.
        break
    }
  }
  return parts.join('\n')
}

/**
 * Build the prompt text for one Cursor agent send.
 * @param options - the fully assembled harness request.
 * @param resumed - whether the target agent already holds the conversation;
 *   only the latest user message is then sent.
 * @returns the prompt text.
 */
export function buildPrompt(options: GenerateOptions, resumed: boolean): string {
  if (resumed) {
    const last = options.messages.at(-1)
    return last === undefined ? '' : renderMessage(last)
  }
  const sections: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    sections.push(`System instructions:\n${options.system}`)
  }
  for (const message of options.messages) {
    const text = renderMessage(message)
    if (text.length === 0) continue
    const role = message.role === 'assistant' ? 'Assistant' : 'User'
    sections.push(`${role}:\n${text}`)
  }
  return sections.join('\n\n')
}
