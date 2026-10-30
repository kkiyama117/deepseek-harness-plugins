#!/usr/bin/env node
// Read-only local DSH setup diagnostic. Reuses dsh-market analyzeProfile
// (same composition walk the market uses at boot). Prints bundles, relevant
// overlay rows, managed skill links, and configured subagent/model routes.
// Never prints secret values, !!js expressions, tokens, or command/args.

import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeProfile, parsePatchFile } from '../plugins/dsh-market/lib/check.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = process.argv[2] && !process.argv[2].startsWith('-')
  ? resolve(process.argv[2])
  : join(HOME, 'profiles', process.env.DSH_PROFILE || 'web')

const SECRET_KEY = /pass(?:word|phrase)?|secret|token|api[_-]?key|authorization|credential/i
const ROUTE_IDS = new Set([
  'subagent-fallback',
  'subagent-fallback-worker',
  'subagent-fallback-verify',
  'llm-fallback',
])
const RELEVANT_IDS = new Set([
  ...ROUTE_IDS,
  'observed-trace-emitter',
  'mcp-misakanet',
  'fs-sandbox',
  'bash-sandbox',
  'mirage-fs',
  'mirage-shell',
  'mirage',
  'web-search-deepseek',
  'webserver',
  'ui-dsh-aionui-panel',
])

function isJsExpr(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.__jsExpr === 'string'
}

function pickScalars(obj, keys) {
  const out = {}
  if (obj === null || typeof obj !== 'object' || isJsExpr(obj)) return out
  for (const key of keys) {
    if (SECRET_KEY.test(key)) continue
    const value = obj[key]
    if (value === undefined || isJsExpr(value)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

/** Safe slice of a route config: provider/model names only. */
export function safeRoute(config) {
  if (!config || typeof config !== 'object' || isJsExpr(config)) return {}
  const out = pickScalars(config, ['toolName', 'provider', 'serverName', 'transport'])
  if (config.primary && typeof config.primary === 'object') {
    out.primary = pickScalars(config.primary, ['provider', 'model'])
  }
  if (Array.isArray(config.fallbackRoutes)) {
    out.fallbackRoutes = config.fallbackRoutes
      .filter((row) => row && typeof row === 'object' && !isJsExpr(row))
      .map((row) => pickScalars(row, ['provider', 'model']))
  }
  if (config.chains && typeof config.chains === 'object' && !isJsExpr(config.chains)) {
    const chains = {}
    for (const [name, hops] of Object.entries(config.chains)) {
      if (!Array.isArray(hops)) continue
      chains[name] = hops
        .filter((row) => row && typeof row === 'object' && !isJsExpr(row))
        .map((row) => pickScalars(row, ['provider', 'model']))
    }
    out.chains = chains
  }
  if (Array.isArray(config.providers)) {
    out.providers = config.providers.filter((item) => typeof item === 'string')
  }
  return out
}

function walkPatchRows(patches) {
  const rows = []
  const walk = (arr) => {
    if (!Array.isArray(arr)) return
    for (const entry of arr) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id === 'string') {
        rows.push({
          id: entry.id,
          name: typeof entry.name === 'string' ? entry.name : undefined,
          disabled: entry.disabled === true ? true : isJsExpr(entry.disabled) ? '(js-expr)' : false,
          config: entry.config,
        })
      }
      if (Array.isArray(entry.config)) walk(entry.config)
    }
  }
  for (const patch of patches ?? []) {
    if (patch === null || typeof patch !== 'object') continue
    if (Array.isArray(patch.insert)) walk(patch.insert)
    if (typeof patch.id === 'string' && !patch.insert) {
      rows.push({
        id: patch.id,
        name: typeof patch.name === 'string' ? patch.name : undefined,
        disabled: patch.disabled === true ? true : isJsExpr(patch.disabled) ? '(js-expr)' : false,
        config: patch.config,
      })
    }
  }
  return rows
}

function managedSkills(skillsDir) {
  if (!existsSync(skillsDir)) return []
  const repoSkills = join(REPO, 'skills')
  const out = []
  for (const name of readdirSync(skillsDir).sort()) {
    const path = join(skillsDir, name)
    let stat
    try { stat = lstatSync(path) } catch { continue }
    if (!stat.isSymbolicLink()) {
      out.push({ name, kind: 'directory', managed: false })
      continue
    }
    let target
    try { target = readlinkSync(path) } catch { continue }
    const resolved = resolve(skillsDir, target)
    const managed = resolved === repoSkills || resolved.startsWith(repoSkills + '/')
    out.push({
      name,
      kind: 'symlink',
      target: relative(REPO, resolved) || resolved,
      managed,
    })
  }
  return out
}

function findDshInstall() {
  if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL
  const guess = join(HOME, 'cli', 'node_modules', '@deepseek-ai', 'dsh')
  return existsSync(join(guess, 'package.json')) ? guess : undefined
}

if (process.argv.includes('--self-check')) {
  const leaked = safeRoute({
    token: 'SECRETVALUE',
    command: 'should-not-appear',
    args: ['nope'],
    primary: { provider: 'cursor', model: 'grok-4.6', apiKey: 'SECRETVALUE' },
  })
  const text = JSON.stringify(leaked)
  if (text.includes('SECRETVALUE') || text.includes('should-not-appear') || text.includes('apiKey')) {
    console.error('self-check: leaked a secret or command field')
    process.exit(1)
  }
  if (leaked.primary?.model !== 'grok-4.6') {
    console.error('self-check: dropped a safe route field')
    process.exit(1)
  }
  console.log('ok')
  process.exit(0)
}

const dshInstall = findDshInstall()
const report = analyzeProfile(PROFILE, { homeDir: HOME, dshInstallDir: dshInstall })
const homePatch = join(HOME, 'cordis.patch.yml')
const userPatch = join(PROFILE, 'cordis.patch.yml')
const homeRows = existsSync(homePatch) ? walkPatchRows(parsePatchFile(homePatch)) : []
const userRows = existsSync(userPatch) ? walkPatchRows(parsePatchFile(userPatch)) : []

const routes = homeRows
  .filter((row) => ROUTE_IDS.has(row.id))
  .map((row) => ({ id: row.id, name: row.name, ...safeRoute(row.config) }))

const overlay = [
  ...userRows
    .filter((row) => RELEVANT_IDS.has(row.id))
    .map((row) => ({ layer: 'user-patch', id: row.id, name: row.name, disabled: row.disabled })),
  ...homeRows.map((row) => ({ layer: 'home-patch', id: row.id, name: row.name, disabled: row.disabled })),
]

const composedRelevant = report.rows
  .filter((row) => RELEVANT_IDS.has(row.id))
  .map((row) => ({ id: row.id, layer: row.layer, kind: row.kind, name: row.name }))

const out = {
  profile: report.profile,
  home: HOME,
  repo: REPO,
  dshInstall: dshInstall ?? null,
  summary: report.summary,
  bundles: report.bundles.map((b) => ({
    name: b.name,
    source: b.source,
    kind: b.kind,
    resolved: b.directory !== null,
    error: b.error,
  })),
  overlayRows: overlay,
  composedRelevant,
  managedSkills: managedSkills(join(HOME, 'skills')),
  routes,
}

console.log(JSON.stringify(out, null, 2))
