/**
 * Real-composition guard for the dynamic-configuration chain: LlmRuntime,
 * settings-file, credentials-local, and llm-cursor boot from a test-only
 * cordis.yml through the actual Loader + Include path, external edits of
 * settings.yaml and the credentials document hot-publish through their
 * providers, and the very next request carries the fresh state root and
 * credential. The same adapter composition without settings or credentials
 * entries keeps entry-config behavior — the documented optional-inject
 * fallback.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmCursor from '@kkiyama117/dsh-llm-cursor'
import { assemble } from './assemble.ts'

const sdkMocks = vi.hoisted(() => {
  const stores: Array<{ rootDir: string }> = []
  return {
    create: vi.fn(),
    resume: vi.fn(),
    stores,
  }
})

vi.mock('@cursor/sdk', () => ({
  Agent: { create: sdkMocks.create, resume: sdkMocks.resume },
  JsonlLocalAgentStore: class JsonlLocalAgentStore {
    constructor(public readonly rootDir: string) {
      sdkMocks.stores.push(this)
    }
  },
}))

const NS = settingsNamespace('llm-cursor')
const KEY_REF = credentialRef('CURSOR_API_KEY')

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  // Hermetic against a real ambient CURSOR_API_KEY: the credentials seam
  // ranks the inherited environment above the file store, so an exported key
  // would otherwise win over every stored test key.
  vi.stubEnv('CURSOR_API_KEY', '')
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

async function loadComposition(
  options: { withDynamic: boolean; stateRootName: string; reuseRoot?: string },
): Promise<{ ctx: Context; settingsPath: string; credentialsPath: string; stateRoot: string }> {
  const fresh = options.reuseRoot === undefined
  root = options.reuseRoot ?? await mkdtemp(join(tmpdir(), 'dsh-llm-cursor-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  const credentialsPath = join(root, '.credentials.yaml')
  const stateRoot = join(root, options.stateRootName)
  if (options.withDynamic && fresh) {
    await writeFile(settingsPath, '# personal settings\n')
    await writeFile(credentialsPath, 'CURSOR_API_KEY: boot-key\n', { mode: 0o600 })
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    ...options.withDynamic
      ? [
        '- id: settings',
        "  name: '@deepseek-ai/dsh-settings-file'",
        '  config:',
        `    path: ${JSON.stringify(settingsPath)}`,
        '    debounceMs: 10',
        '- id: credentials',
        "  name: '@deepseek-ai/dsh-credentials-local'",
        '  config:',
        `    path: ${JSON.stringify(credentialsPath)}`,
        '    debounceMs: 10',
      ]
      : [],
    '- id: llm-cursor',
    "  name: '@kkiyama117/dsh-llm-cursor'",
    '  config:',
    `    stateRoot: ${JSON.stringify(stateRoot)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@kkiyama117/dsh-llm-cursor', LlmCursor],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath, credentialsPath, stateRoot }
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

describe('loader composition', () => {
  it('boots the dynamic chain and hot-publishes external edits', async () => {
    const run = stubRun()
    const agent = stubAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { ctx, settingsPath, credentialsPath, stateRoot } = await loadComposition({
      withDynamic: true,
      stateRootName: 'state-a',
    })

    await assemble(ctx, { model: 'default', messages: [] })
    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'boot-key' }))
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe(stateRoot)

    // External edits flow through the file providers into the next request.
    const stateRootB = join(root!, 'state-b')
    await writeFile(settingsPath, `llm-cursor:\n  stateRoot: ${JSON.stringify(stateRootB)}\n`)
    await writeFile(credentialsPath, 'CURSOR_API_KEY: edited-key\n', { mode: 0o600 })
    await vi.waitFor(() => {
      expect((ctx.get('settings')!.get(NS) as { stateRoot?: string }).stateRoot).toBe(stateRootB)
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect(await ctx.get('credentials')!.resolve(KEY_REF)).toEqual({ value: 'edited-key', source: 'file' })
    }, { timeout: 5000 })
    sdkMocks.create.mockClear()
    await assemble(ctx, { model: 'default', messages: [] })
    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'edited-key' }))
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe(stateRootB)
  })

  it('keeps entry-config behavior without the settings and credentials entries', async () => {
    vi.stubEnv('CURSOR_API_KEY', 'env-key')
    const run = stubRun()
    const agent = stubAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    const { ctx, stateRoot } = await loadComposition({ withDynamic: false, stateRootName: 'state-a' })

    await assemble(ctx, { model: 'default', messages: [] })
    expect(sdkMocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-key' }))
    expect(sdkMocks.stores.at(-1)?.rootDir).toBe(stateRoot)
  })

  it('resumes the agent on the next request through the durable replay state', async () => {
    const run = stubRun()
    const agent = stubAgent(run)
    sdkMocks.create.mockResolvedValue(agent)
    sdkMocks.resume.mockResolvedValue(agent)
    const { ctx } = await loadComposition({ withDynamic: true, stateRootName: 'state-a' })

    const first = await assemble(ctx, { model: 'default', messages: [] })
    expect(first.finish).toEqual({ kind: 'stop' })
    expect(first.message.source).toMatchObject({ kind: 'model', provider: 'cursor', model: 'default' })
    const replayState = first.message.source.kind === 'model' ? first.message.source.replayState : undefined
    expect(replayState).toEqual({ response: { kind: 'cursor', version: 1, agentId: 'agent-1' } })

    // The second request carries the durable replay state and resumes.
    sdkMocks.create.mockClear()
    const followUp = createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await assemble(ctx, { model: 'default', messages: [first.message, followUp] })
    expect(sdkMocks.resume).toHaveBeenCalledWith('agent-1', expect.anything())
    expect(sdkMocks.create).not.toHaveBeenCalled()
  })
})
