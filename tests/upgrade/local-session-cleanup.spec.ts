/** Real Session lifetime integration for the external cleanup plugin. */
import { it, expect, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai'
import * as cleanup from '../../plugins/dsh-session-cleanup/src/index.ts'

it('releases only an announced disposed Session and retains the other live Session', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(cleanup)
  const cleaned: string[] = []
  onTestFinished(registerSessionResourceCleanup(id => { if (id !== undefined) cleaned.push(id) }))
  const a = ctx.sessions.prepare()
  const b = ctx.sessions.prepare()
  const releaseA = ctx.sessions.enter(a)
  const releaseB = ctx.sessions.enter(b)
  onTestFinished(() => { releaseA(); releaseB() })
  ctx.sessions.announce(a)
  ctx.sessions.announce(b)
  expect(cleaned).toEqual([])
  releaseA()
  expect(cleaned).toEqual([a.id])
  expect(ctx.sessions.get(b.id)).toBe(b)
  releaseB()
  expect(cleaned).toEqual([a.id, b.id])
})

it('removes the effect-owned listener when the plugin unloads', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(cleanup)
  const cleaned: string[] = []
  onTestFinished(registerSessionResourceCleanup(id => { if (id !== undefined) cleaned.push(id) }))
  const session = ctx.sessions.prepare()
  const release = ctx.sessions.enter(session)
  onTestFinished(release)
  ctx.sessions.announce(session)
  await fiber.dispose()
  release()
  expect(cleaned).toEqual([])
})
