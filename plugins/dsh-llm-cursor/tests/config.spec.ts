import { describe, expect, it } from 'vitest'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveAdapterOptions,
} from '../src/index.ts'

describe('resolveAdapterOptions', () => {
  it('resolves every default for an empty config', () => {
    expect(resolveAdapterOptions({})).toEqual({
      apiKeyEnv: credentialRef('CURSOR_API_KEY'),
      runtime: 'local',
      cwd: process.cwd(),
      stateRoot: dshHomePath('cursor'),
      mode: 'agent',
      models: [
        { id: 'default', name: 'Default', contextWindow: DEFAULT_CONTEXT_WINDOW },
        { id: 'composer-2.5', name: 'Composer 2.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
      ],
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'test'),
      params: [],
    })
  })

  it('resolves a fully specified config', () => {
    const resolved = resolveAdapterOptions({
      apiKeyEnv: 'MY_CURSOR_KEY',
      runtime: 'cloud',
      cwd: '/elsewhere',
      stateRoot: '/state/root',
      mode: 'plan',
      models: [{ id: 'm1', name: 'M1', description: 'desc', contextWindow: 200_000 }],
      defaultContextWindow: 300_000,
      streamIdleTimeoutMs: 60_000,
      retryPolicy: { mode: 'normal', maxRetries: 2 },
      params: [{ id: 'thinking', value: 'true' }],
    })
    expect(resolved).toMatchObject({
      apiKeyEnv: credentialRef('MY_CURSOR_KEY'),
      runtime: 'cloud',
      cwd: '/elsewhere',
      stateRoot: '/state/root',
      mode: 'plan',
      models: [{ id: 'm1', name: 'M1', description: 'desc', contextWindow: 200_000 }],
      defaultContextWindow: 300_000,
      streamIdleTimeoutMs: 60_000,
      params: [{ id: 'thinking', value: 'true' }],
    })
    expect(resolved.retryPolicy.mode).toBe('normal')
    if (resolved.retryPolicy.mode !== 'normal') throw new Error('expected a normal retry policy')
    expect(resolved.retryPolicy.maxRetries).toBe(2)
  })

  it('rejects an invalid stream idle timeout', () => {
    for (const streamIdleTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => resolveAdapterOptions({ streamIdleTimeoutMs })).toThrow(/streamIdleTimeoutMs/)
    }
  })

  it('rejects a non-positive default context window', () => {
    for (const defaultContextWindow of [0, -5, 1.5]) {
      expect(() => resolveAdapterOptions({ defaultContextWindow })).toThrow(/defaultContextWindow/)
    }
  })

  it('rejects an empty cwd for the local runtime', () => {
    expect(() => resolveAdapterOptions({ runtime: 'local', cwd: '' })).toThrow(/cwd/)
  })

  it('rejects an empty state root', () => {
    expect(() => resolveAdapterOptions({ stateRoot: '' })).toThrow(/stateRoot/)
  })

  it('rejects model params with an empty id or value', () => {
    expect(() => resolveAdapterOptions({ params: [{ id: '', value: 'x' }] })).toThrow(/params/)
    expect(() => resolveAdapterOptions({ params: [{ id: 'x', value: '' }] })).toThrow(/params/)
  })

  it('rejects an invalid advisory catalog', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: '' }] })).toThrow(/non-empty/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'm', name: '' }] })).toThrow(/empty name/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'm', contextWindow: 0 }] })).toThrow(/contextWindow/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'm' }, { id: 'm' }] })).toThrow(/duplicate/)
  })

  it('detaches the catalog and params arrays', () => {
    const models = [{ id: 'm1' }]
    const params = [{ id: 'thinking', value: 'true' }]
    const resolved = resolveAdapterOptions({ models, params })
    expect(resolved.models).not.toBe(models)
    expect(resolved.params).not.toBe(params)
  })
})
