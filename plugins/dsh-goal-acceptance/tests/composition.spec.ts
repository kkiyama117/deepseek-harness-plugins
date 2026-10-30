import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const target = process.env.DSH_TEST_TARGET!
const driver = join(target, 'packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts')
const patch = fileURLToPath(new URL('./fixtures/acceptance.patch.yml', import.meta.url))
const tsconfig = join(target, 'tsconfig.json')

async function logs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? logs(path) : Promise.resolve(entry.name.endsWith('.jsonl') ? [path] : [])
  }))).flat()
}

it('leaves the three-theme Goal active despite a normally finished headless turn', async () => {
  let events: SessionEvent[] = []
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'request-acceptance', tempDirPrefix: 'dsh-request-acceptance-',
    binScript: driver, libBinScript: driver, configPath: patch,
    binArgs: [patch, 'Slack Intake is an intake environment, not the target. Verify Bend/GPU, 学振審査, and Codex/Astra with material-specific work.'],
    tsconfigPath: tsconfig, env: { DSH_LOADER_SMOKE_REQUIRED_ENTRY_ID: 'acceptance-fixture' },
    inspect: async (cwd) => {
      const paths = await logs(join(cwd, '.sessions'))
      expect(paths).toHaveLength(1)
      events = (await readFile(paths[0]!, 'utf8')).trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
    },
  })
  expect(stderr).toBe('')
  expect(stdout).toContain('NOT_COMPLETE')
  expect(stdout).toContain('GATEWAY_POLICY_REJECTED_WITHOUT_MUTATION')
  const changes = events.filter(event => event.type === 'goal/change')
  expect(changes).toHaveLength(1)
  expect(changes[0]?.data).toMatchObject({ goal: { phase: 'active' } })
  expect(events.findLast(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  expect(results[0]?.data).toMatchObject({ meta: { kind: 'request-check', checkpoint: { items: [
    { id: 'theme-1', quote: 'Bend/GPU', status: 'not-applicable' },
    { id: 'theme-2', quote: '学振審査', status: 'not-applicable' },
    { id: 'theme-3', quote: 'Codex/Astra', status: 'not-applicable' },
  ] } } })
  expect(results[1]?.data).toMatchObject({ message: { isError: true }, error: { code: 'GOAL_ACCEPTANCE_MISSING' } })
  const visible = events.filter(event => event.type === 'system/message').map(event => JSON.stringify(event.data))
  expect(visible.some(text => text.includes('<original_request>'))).toBe(true)
  expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(3)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
