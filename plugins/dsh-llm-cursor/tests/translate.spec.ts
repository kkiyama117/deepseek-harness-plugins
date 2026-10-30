import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SDKMessage } from '@cursor/sdk'
import { closeBlocks, createTranslateState, mapSdkError, mapUsage, translateMessage } from '../src/translate.ts'

function message(partial: SDKMessage): SDKMessage {
  return partial
}

describe('createTranslateState', () => {
  it('starts the block index at zero', () => {
    expect(createTranslateState()).toEqual({ nextIndex: 0 })
  })
})

describe('mapUsage', () => {
  it('copies the disjoint token counts and keeps the optional reasoning count', () => {
    expect(mapUsage({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 37,
      reasoningTokens: 5,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 5,
    })
  })

  it('omits the reasoning count when the SDK did not report one', () => {
    expect(mapUsage({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3,
    })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
})

describe('translateMessage', () => {
  it('opens a reasoning block for the first thinking delta and accumulates later deltas', () => {
    const state = createTranslateState()
    expect(translateMessage(message({
      type: 'thinking',
      agent_id: 'a',
      run_id: 'r',
      text: 'pon',
    }), state)).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'pon' },
    ])
    expect(translateMessage(message({
      type: 'thinking',
      agent_id: 'a',
      run_id: 'r',
      text: 'der',
    }), state)).toEqual([
      { type: 'reasoning-delta', index: 0, text: 'der' },
    ])
    expect(state.nextIndex).toBe(1)
    expect(closeBlocks(state)).toEqual([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'ponder' } },
    ])
  })

  it('skips the empty thinking message that marks completion', () => {
    const state = createTranslateState()
    expect(translateMessage(message({
      type: 'thinking',
      agent_id: 'a',
      run_id: 'r',
      text: '',
      thinking_duration_ms: 12,
    }), state)).toEqual([])
    expect(closeBlocks(state)).toEqual([])
  })

  it('opens one text block per stream and accumulates assistant deltas, skipping tool_use blocks', () => {
    const state = createTranslateState()
    expect(translateMessage(message({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
          { type: 'text', text: 'world' },
        ],
      },
    }), state)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'text-delta', index: 0, text: 'world' },
    ])
    expect(state.nextIndex).toBe(1)
    expect(closeBlocks(state)).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'helloworld' } },
    ])
  })

  it('accumulates per-delta assistant messages into one text block', () => {
    const state = createTranslateState()
    const delta = (text: string): SDKMessage => message({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })
    expect(translateMessage(delta('h'), state)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'h' },
    ])
    expect(translateMessage(delta('i'), state)).toEqual([
      { type: 'text-delta', index: 0, text: 'i' },
    ])
    expect(state.nextIndex).toBe(1)
    expect(closeBlocks(state)).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    ])
  })

  it('translates a usage message into one usage chunk', () => {
    const state = createTranslateState()
    expect(translateMessage(message({
      type: 'usage',
      agent_id: 'a',
      run_id: 'r',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 3,
      },
    }), state)).toEqual([{
      type: 'usage',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }])
  })

  it('ignores system, user, tool_call, status, request, and task messages', () => {
    const state = createTranslateState()
    const ignored: SDKMessage[] = [
      { type: 'system', agent_id: 'a', run_id: 'r' },
      { type: 'user', agent_id: 'a', run_id: 'r', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'tool_call', agent_id: 'a', run_id: 'r', call_id: 'c', name: 'bash', status: 'completed' },
      { type: 'status', agent_id: 'a', run_id: 'r', status: 'RUNNING' },
      { type: 'request', agent_id: 'a', run_id: 'r', request_id: 'q' },
      { type: 'task', agent_id: 'a', run_id: 'r' },
    ]
    for (const item of ignored) {
      expect(translateMessage(item, state)).toEqual([])
    }
    expect(state.nextIndex).toBe(0)
  })
})

describe('mapSdkError', () => {
  it('passes harness errors through unchanged', () => {
    const original = new LlmError('already mapped', 'AUTH')
    expect(mapSdkError(original)).toBe(original)
  })

  it('maps the SDK error classes to stable harness codes', () => {
    const cases: Array<[string, string]> = [
      ['AuthenticationError', 'AUTH'],
      ['RateLimitError', 'RATE_LIMIT'],
      ['NetworkError', 'SERVER'],
      ['AgentBusyError', 'INVALID_REQUEST'],
      ['UnknownAgentError', 'INVALID_REQUEST'],
      ['ConfigurationError', 'INVALID_REQUEST'],
    ]
    for (const [name, code] of cases) {
      const error = Object.assign(new Error(name), { name })
      const mapped = mapSdkError(error)
      expect(mapped.code).toBe(code)
      expect(mapped.cause).toBe(error)
    }
  })

  it('maps a retryable generic SDK error to SERVER and a non-retryable one to INVALID_REQUEST', () => {
    const retryable = Object.assign(new Error('boom'), { name: 'CursorSdkError', isRetryable: true })
    expect(mapSdkError(retryable).code).toBe('SERVER')
    const terminal = Object.assign(new Error('boom'), { name: 'CursorSdkError', isRetryable: false })
    expect(mapSdkError(terminal).code).toBe('INVALID_REQUEST')
    const agent = Object.assign(new Error('boom'), { name: 'CursorAgentError', isRetryable: true })
    expect(mapSdkError(agent).code).toBe('SERVER')
  })

  it('maps anything else to TRANSPORT', () => {
    const mapped = mapSdkError(new Error('dns failed'))
    expect(mapped.code).toBe('TRANSPORT')
    expect(mapped.cause).toBeInstanceOf(Error)
  })

  it('maps non-object throws and objects without a string name to TRANSPORT', () => {
    expect(mapSdkError('boom').code).toBe('TRANSPORT')
    expect(mapSdkError({ name: 42 }).code).toBe('TRANSPORT')
  })
})
