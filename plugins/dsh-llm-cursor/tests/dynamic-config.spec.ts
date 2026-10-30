import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { INVALID_CREDENTIAL_CODE } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmCursor from '@kkiyama117/dsh-llm-cursor'
import { assemble } from './assemble.ts'

const sdkMocks = vi.hoisted(() => {
  const stores: Array<{ rootDir: string }> = []
  return {
    create: vi.fn(),
    resume: vi.fn(),
    listModels: vi.fn(),
    stores,
  }
})

vi.mock('@cursor/sdk', () => ({
  Agent: { create: sdkMocks.create, resume: sdkMocks.resume },
  Cursor: { models: { list: sdkMocks.listModels } },
  JsonlLocalAgentStore: class JsonlLocalAgentStore {
    constructor(public readonly rootDir: string) {
      sdkMocks.stores.push(this)
    }
  },
}))

const NS = settingsNamespace('llm-cursor')
const KEY_REF = credentialRef('CURSOR_API_KEY')

const cleanups: Array<() => Promise<void>> = []

beforeEach(() => {
  // Hermetic against a real ambient CURSOR_API_KEY: the credentials seam
  // ranks the inherited environment above the file store, so an exported key
  // would otherwise win over every stored test key.
  vi.stubEnv('CURSOR_API_KEY', '')
})

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-cursor-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
  settingsFiber: { dispose(): Promise<void> }
}

async function boot(dir: string, config: object): Promise<Harness> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await settingsFiber
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmCursor, config)
  return { ctx, settingsFiber }
}

function stubRun() {
  const run = {
    id: 'run-1',
    agentId: 'agent-1',
    cancel: vi.fn(async () => {}),
    wait: vi.fn(async () => ({ id: 'run-1', status: 'finished' as const })),
    stream: vi.fn(async function* () {
      yield { type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' as const }
    }),
  }
  return run
}

function stubAgent(run: ReturnType<typeof stubRun>) {
  return {
    agentId: 'agent-1',
    send: vi.fn(async () => run),
    close: vi.fn(),
  }
}

function prompt(ctx: Context) {
  return assemble(ctx, { model: 'default', messages: [] })
}

describe('request-level dynamic configuration', () => {
  it('routes the next request with the freshly resolved state root and credential', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'CURSOR_API_KEY: first-key\n', { mode: 0o600 })
    const run = stubRun()
    const agent = stubAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { ctx } = await boot(dir, { stateRoot: join(dir, 'state-a') })

    await prompt(ctx)
    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'first-key' }))
    expect(sdkMocks.create.mock.calls[0]?.[0]).toMatchObject({ local: { cwd: process.cwd() } })
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe(join(dir, 'state-a'))

    await ctx.settings.update(NS, { stateRoot: join(dir, 'state-b') })
    await ctx.credentials.set(KEY_REF, 'second-key')
    sdkMocks.create.mockClear()

    await prompt(ctx)
    // No restart, no re-registration: the next request resolved both facts.
    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'second-key' }))
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe(join(dir, 'state-b'))
  })

  it('starts keyless and serves the next request once the key arrives', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const dir = await home()
    const run = stubRun()
    const agent = stubAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { ctx } = await boot(dir, {})

    const keyless = await prompt(ctx)
    expect(keyless.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(sdkMocks.create).not.toHaveBeenCalled()

    await ctx.credentials.set(KEY_REF, 'sk-arrived')
    await prompt(ctx)
    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-arrived' }))
  })

  it('rejects a stored credential no header can carry, never echoing it in the failure', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, {})
    const secret = 'sk-\u{1F600}supersecret'

    await ctx.credentials.set(KEY_REF, secret)
    const result = await prompt(ctx)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: INVALID_CREDENTIAL_CODE } })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message).not.toContain(secret)
    expect(result.finish.failure.message).not.toContain('supersecret')
  })

  it('advertises a live settings catalog without re-registration', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { models: [{ id: 'm1' }] })

    await expect(ctx.llm.listModels('cursor')).resolves.toEqual([
      { provider: 'cursor', id: 'm1', name: 'm1', inputModalities: ['text'] },
    ])
    await ctx.settings.update(NS, { models: [{ id: 'm2', name: 'M2' }] })
    await expect(ctx.llm.listModels('cursor')).resolves.toEqual([
      { provider: 'cursor', id: 'm2', name: 'M2', inputModalities: ['text'] },
    ])
  })

  it('keeps the last good configuration after an invalid settings snapshot', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const dir = await home()
    const run = stubRun()
    const agent = stubAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { ctx } = await boot(dir, { stateRoot: join(dir, 'good') })
    await ctx.credentials.set(KEY_REF, 'sk-good')

    await prompt(ctx)
    expect(sdkMocks.create.mock.calls[0]?.[0]).toMatchObject({ local: { cwd: process.cwd() } })
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe(join(dir, 'good'))

    await ctx.settings.update(NS, { stateRoot: '' })
    sdkMocks.create.mockClear()
    await prompt(ctx)
    expect(sdkMocks.create.mock.calls[0]?.[0]).toMatchObject({ local: { cwd: process.cwd() } })
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe(join(dir, 'good'))
  })

  it('answers discovery from the configured catalog for its own route', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, {
      models: [{ id: 'm1', name: 'M1', description: 'desc' }, { id: 'm2' }],
    })

    // The seam normalizes discovery replies to id/name/capacity fields.
    await expect(ctx.llm.discoverModels(NS, { provider: 'cursor' })).resolves.toEqual([
      { id: 'm1', name: 'M1' },
      { id: 'm2' },
    ])
  })

  it('fetches the live catalog with the key typed in the draft', async () => {
    const dir = await home()
    sdkMocks.listModels.mockResolvedValue([
      { id: 'm1', displayName: 'M1', description: 'desc' },
      { id: 'm2' },
    ])
    const { ctx } = await boot(dir, {})

    await expect(ctx.llm.discoverModels(NS, { provider: 'cursor', apiKey: 'draft-key' })).resolves.toEqual([
      { id: 'm1', name: 'M1' },
      { id: 'm2' },
    ])
    expect(sdkMocks.listModels).toHaveBeenCalledWith({ apiKey: 'draft-key' })
  })

  it('fetches the live catalog with the stored key when the draft has none', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const dir = await home()
    sdkMocks.listModels.mockResolvedValue([{ id: 'm1', displayName: 'M1' }])
    const { ctx } = await boot(dir, {})
    await ctx.credentials.set(KEY_REF, 'stored-key')

    await expect(ctx.llm.discoverModels(NS, { provider: 'cursor' })).resolves.toEqual([
      { id: 'm1', name: 'M1' },
    ])
    expect(sdkMocks.listModels).toHaveBeenCalledWith({ apiKey: 'stored-key' })
  })

  it('fails discovery when the live listing fails', async () => {
    const dir = await home()
    sdkMocks.listModels.mockRejectedValue(new Error('network down'))
    const { ctx } = await boot(dir, {})

    await expect(ctx.llm.discoverModels(NS, { provider: 'cursor', apiKey: 'draft-key' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('rejects a typed key no HTTP header can carry', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, {})

    await expect(ctx.llm.discoverModels(NS, { provider: 'cursor', apiKey: 'bad \u{1F600} key' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(sdkMocks.listModels).not.toHaveBeenCalled()
  })

  it('rejects a stored key no HTTP header can carry during discovery', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, {})
    await ctx.credentials.set(KEY_REF, 'bad \u{1F600} key')

    await expect(ctx.llm.discoverModels(NS, { provider: 'cursor' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(sdkMocks.listModels).not.toHaveBeenCalled()
  })

  it('refuses discovery against a base URL or a foreign route', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, {})

    await expect(ctx.llm.discoverModels(NS, { baseURL: 'https://example.com' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
    await expect(ctx.llm.discoverModels(NS, { provider: 'other-route' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
  })

  it('fails plugin load when the entry config cannot resolve', async () => {
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })
    await ctx.plugin(LlmRuntime)

    await expect(ctx.plugin(LlmCursor, { stateRoot: '' })).rejects.toThrow(/stateRoot/)
  })

  it('reads the key from the launching environment without the credentials seam', async () => {
    vi.stubEnv('CURSOR_API_KEY', 'env-key')
    const run = stubRun()
    const agent = stubAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCursor, {})

    await prompt(ctx)
    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-key' }))
  })

  it('fails with MISSING_CREDENTIAL without the credentials seam and no ambient key', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCursor, {})

    const result = await prompt(ctx)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('re-registers the route when the retry policy changes through settings', async () => {
    vi.stubEnv('CURSOR_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, { retryPolicy: { mode: 'normal', maxRetries: 1 } })

    const policy = (): number => {
      const resolved = ctx.llm.providerRetryPolicy('cursor')
      if (resolved.mode !== 'normal') throw new Error('expected a normal retry policy')
      return resolved.maxRetries
    }
    expect(policy()).toBe(1)
    await ctx.settings.update(NS, { retryPolicy: { mode: 'normal', maxRetries: 5 } })
    expect(policy()).toBe(5)
  })
})
