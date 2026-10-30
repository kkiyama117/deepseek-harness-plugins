import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { buildPrompt, renderMessage } from '../src/prompt.ts'

function user(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

function assistant(text: string) {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'cursor', model: 'default' },
  })
}

describe('renderMessage', () => {
  it('joins text blocks and renders tool calls and results as a transcript', () => {
    const message = createMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'tool-call', id: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' },
        { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false },
        { type: 'text', text: 'last' },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(renderMessage(message)).toBe('first\n[tool call bash({"command":"ls"})]\n[tool result: ok]\nlast')
  })

  it('skips reasoning blocks and unknown merge-extensible block types', () => {
    const message = createMessage({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'visible' },
        { type: 'unknown-block', text: 'ignored' } as never,
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(renderMessage(message)).toBe('visible')
  })
})

describe('buildPrompt', () => {
  it('flattens the system prompt and history for a fresh agent', () => {
    const options: GenerateOptions = {
      provider: 'cursor',
      model: 'default',
      system: 'be careful',
      messages: [user('hello'), assistant('hi'), user('again')],
    }
    expect(buildPrompt(options, false)).toBe(
      'System instructions:\nbe careful\n\nUser:\nhello\n\nAssistant:\nhi\n\nUser:\nagain',
    )
  })

  it('omits the system section when empty and skips empty renderings', () => {
    const reasoningOnly = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'hidden' }],
      source: { provider: 'cursor', model: 'default' },
    })
    const options: GenerateOptions = {
      provider: 'cursor',
      model: 'default',
      messages: [reasoningOnly, user('only user')],
    }
    expect(buildPrompt(options, false)).toBe('User:\nonly user')
  })

  it('sends only the latest user message to a resumed agent', () => {
    const options: GenerateOptions = {
      provider: 'cursor',
      model: 'default',
      system: 'ignored on resume',
      messages: [user('old'), assistant('old reply'), user('new')],
    }
    expect(buildPrompt(options, true)).toBe('new')
  })

  it('renders an empty prompt when a resumed agent has no messages', () => {
    const options: GenerateOptions = { provider: 'cursor', model: 'default', messages: [] }
    expect(buildPrompt(options, true)).toBe('')
  })

  it('renders tool results as user-role content in the flattened history', () => {
    const result = createToolResultMessage({
      callId: CallId('c1'),
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    })
    const options: GenerateOptions = {
      provider: 'cursor',
      model: 'default',
      messages: [user('run it'), result],
    }
    expect(buildPrompt(options, false)).toBe('User:\nrun it\n\nUser:\n[tool result: done]')
  })
})
