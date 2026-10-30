/**
 * Cursor SDK message → harness `StreamChunk` translation and SDK error
 * mapping. Pure functions: the adapter owns stream lifecycle, this module owns
 * vocabulary conversion.
 *
 * @module dsh-llm-cursor/translate
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SDKMessage, TokenUsage as SdkTokenUsage } from '@cursor/sdk'

/** Mutable block-index allocator shared by one stream's translations. */
export interface TranslateState {
  /** Next block index to allocate; the adapter owns its lifecycle. */
  nextIndex: number
  /** Open text block accumulating SDK text deltas; closed by {@link closeBlocks}. */
  textBlock?: { index: number; text: string }
  /** Open reasoning block accumulating SDK thinking deltas; closed by {@link closeBlocks}. */
  reasoningBlock?: { index: number; text: string }
}

/**
 * Create the per-stream translation state.
 * @returns a fresh block-index allocator.
 */
export function createTranslateState(): TranslateState {
  return { nextIndex: 0 }
}

/**
 * Copy the SDK's disjoint token counts into the harness vocabulary. The two
 * shapes agree field for field; only the optional reasoning count is
 * conditional.
 * @param usage - per-turn or cumulative SDK token usage.
 * @returns the harness token usage value.
 */
export function mapUsage(usage: SdkTokenUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    ...usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
  }
}

/**
 * Translate one SDK message into harness chunks. The Cursor agent loop
 * executes its own tools inside the SDK, so `tool_call` messages and
 * assistant `tool_use` blocks are deliberately NOT replayed as harness
 * tool-call blocks: the harness would execute them a second time. The
 * harness sees reasoning, text, and usage; terminal status handling is the
 * adapter's, and the remaining message kinds are transport bookkeeping.
 *
 * The SDK streams one message per delta — an `assistant` message per text
 * delta and a `thinking` message per reasoning delta — so deltas accumulate
 * into one open block per kind instead of one block per message (a block per
 * message would render every character on its own line). The adapter closes
 * the open blocks with {@link closeBlocks} once the stream ends.
 * @param message - one SDK stream message.
 * @param state - the stream's block-index allocator.
 * @returns the harness chunks for this message.
 */
export function translateMessage(message: SDKMessage, state: TranslateState): StreamChunk[] {
  switch (message.type) {
    case 'thinking': {
      // An empty text marks thinking completion, not a delta.
      if (message.text.length === 0) return []
      const chunks: StreamChunk[] = []
      if (state.reasoningBlock === undefined) {
        state.reasoningBlock = { index: state.nextIndex++, text: '' }
        chunks.push({ type: 'block-start', index: state.reasoningBlock.index, blockType: 'reasoning' })
      }
      state.reasoningBlock.text += message.text
      chunks.push({ type: 'reasoning-delta', index: state.reasoningBlock.index, text: message.text })
      return chunks
    }
    case 'assistant': {
      const chunks: StreamChunk[] = []
      for (const block of message.message.content) {
        if (block.type !== 'text') continue
        if (state.textBlock === undefined) {
          state.textBlock = { index: state.nextIndex++, text: '' }
          chunks.push({ type: 'block-start', index: state.textBlock.index, blockType: 'text' })
        }
        state.textBlock.text += block.text
        chunks.push({ type: 'text-delta', index: state.textBlock.index, text: block.text })
      }
      return chunks
    }
    case 'usage':
      return [{ type: 'usage', usage: mapUsage(message.usage) }]
    default:
      // system, user, tool_call, status, request, and task messages carry no
      // harness-visible content: status terminal handling is the adapter's,
      // and the rest are SDK transport bookkeeping.
      return []
  }
}

/**
 * Close every block {@link translateMessage} left open, so each block the
 * harness saw opened is finalized with its accumulated text. The adapter
 * calls this once the stream ends, before the usage and finish chunks.
 * @param state - the stream's block-index allocator.
 * @returns the closing chunks for the open blocks.
 */
export function closeBlocks(state: TranslateState): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (state.reasoningBlock !== undefined) {
    chunks.push({
      type: 'block-end',
      index: state.reasoningBlock.index,
      block: { type: 'reasoning', text: state.reasoningBlock.text },
    })
    delete state.reasoningBlock
  }
  if (state.textBlock !== undefined) {
    chunks.push({
      type: 'block-end',
      index: state.textBlock.index,
      block: { type: 'text', text: state.textBlock.text },
    })
    delete state.textBlock
  }
  return chunks
}

/**
 * Map a thrown Cursor SDK error to a stable harness `LlmError`. The SDK's
 * error classes carry the retryability and status facts the harness taxonomy
 * needs; anything else is a transport failure.
 * @param error - the thrown value.
 * @returns the mapped harness error.
 */
export function mapSdkError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { name?: unknown; isRetryable?: unknown }
    const name = typeof candidate.name === 'string' ? candidate.name : ''
    if (name === 'AuthenticationError') {
      return new LlmError('Cursor SDK authentication failed', 'AUTH', { cause: error })
    }
    if (name === 'RateLimitError') {
      return new LlmError('Cursor SDK rate limit exceeded', 'RATE_LIMIT', { cause: error })
    }
    if (name === 'NetworkError') {
      return new LlmError('Cursor SDK network failure', 'SERVER', { cause: error })
    }
    if (name === 'AgentBusyError' || name === 'UnknownAgentError' || name === 'ConfigurationError') {
      return new LlmError(`Cursor SDK request rejected: ${name}`, 'INVALID_REQUEST', { cause: error })
    }
    if (name === 'CursorSdkError' || name === 'CursorAgentError') {
      return new LlmError(
        `Cursor SDK request failed${candidate.isRetryable === true ? ' (retryable)' : ''}`,
        candidate.isRetryable === true ? 'SERVER' : 'INVALID_REQUEST',
        { cause: error },
      )
    }
  }
  return new LlmError('Cursor SDK request failed', 'TRANSPORT', { cause: error })
}
