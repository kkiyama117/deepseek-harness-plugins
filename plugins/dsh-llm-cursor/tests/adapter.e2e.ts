/**
 * Real-API e2e for the Cursor SDK adapter: one fresh-agent turn, one resumed
 * turn, and model discovery against the live Cursor SDK. Key-gated — skips
 * entirely without $CURSOR_API_KEY (see vitest.e2e.config.ts).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmCursor from '@kkiyama117/dsh-llm-cursor'
import { assemble } from './assemble.ts'

const contexts: Context[] = []
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-llm-cursor-e2e-'))
  vi.stubEnv('DSH_HOME', home)
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmCursor, { stateRoot: join(home, 'cursor-state') })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

function textOf(result: Awaited<ReturnType<typeof assemble>>): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('cursor adapter e2e', () => {
  it.skipIf(!process.env.CURSOR_API_KEY)('runs one fresh turn and one resumed turn', async () => {
    const ctx = await harness()

    const first = await assemble(ctx, { model: 'default', messages: ask('Reply with exactly: FIRST-OK') })
    expect(first.finish).toEqual({ kind: 'stop' })
    expect(textOf(first)).toContain('FIRST-OK')
    const replayState = first.message.source.kind === 'model' ? first.message.source.replayState : undefined
    expect(replayState).toMatchObject({ kind: 'cursor', version: 1 })

    // The resumed agent holds the conversation: it can answer a follow-up
    // that references the first exchange.
    const second = await assemble(ctx, {
      model: 'default',
      messages: [...ask('Reply with exactly: SECOND-OK'), first.message],
    })
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(textOf(second)).toContain('SECOND-OK')
  })

  it.skipIf(!process.env.CURSOR_API_KEY)('discovers the live model catalog through the SDK', async () => {
    const apiKey = process.env.CURSOR_API_KEY
    if (apiKey === undefined) throw new Error('guarded by skipIf')
    const { Cursor } = await import('@cursor/sdk')
    const models = await Cursor.models.list({ apiKey })
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]?.id.length).toBeGreaterThan(0)
  })
})
