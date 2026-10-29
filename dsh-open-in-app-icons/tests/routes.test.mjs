/** Real Loader/WebServer composition with deterministic installed-application and authentication inputs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const core = process.env.DSH_ICONS_CORE;
const packageRoot = process.env.DSH_ICONS_PACKAGE;
assert(core && packageRoot, 'Run this suite with bin/test.py');
const requireCore = createRequire(join(core, 'apps/cli/package.json'));
const requireHost = createRequire(join(core, 'packages/host/open-in-app/package.json'));
const { Context } = await import(pathToFileURL(requireCore.resolve('@deepseek-ai/cordis')).href);
const { default: Loader } = await import(pathToFileURL(requireCore.resolve('@deepseek-ai/cordis-plugin-loader')).href);
const { default: Include } = await import(pathToFileURL(requireCore.resolve('@deepseek-ai/cordis-plugin-include')).href);
const { default: WebServer } = await import(pathToFileURL(requireCore.resolve('@deepseek-ai/dsh-host-webserver')).href);
const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-launch-environment')).href);
const OpenInApp = await import(pathToFileURL(join(core, 'packages/host/open-in-app/src/index.ts')).href);
const { internals } = await import(pathToFileURL(join(core, 'packages/host/open-in-app/src/internals.ts')).href);
const Icons = await import(pathToFileURL(join(packageRoot, 'index.mjs')).href);
const icon = await readFile(join(packageRoot, 'assets/fallback.svg'), 'utf8');
const validConfig = { applicationIds: ['filemanager', 'cursor', 'vscode'], cacheMaxAgeSeconds: 3600 };
const headers = { authorization: 'Bearer icon-route-fixture' };
const nativeIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';

async function boot(t, { patched = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-icons-test-'));
  const previous = internals.catalog;
  let ctx;
  t.after(async () => {
    try {
      await ctx?.fiber.dispose();
    } finally {
      internals.catalog = previous;
      assert.equal(dirname(root), resolve(tmpdir()));
      assert(basename(root).startsWith('dsh-icons-test-'));
      await rm(root, { recursive: true, force: true });
    }
  });
  const dataRoot = join(root, 'data');
  await mkdir(join(dataRoot, 'applications'), { recursive: true });
  await mkdir(join(dataRoot, 'icons/hicolor/scalable/apps'), { recursive: true });
  await writeFile(join(dataRoot, 'applications/dev.zed.Zed.desktop'), '[Desktop Entry]\nIcon=test-zed\nExec=zed\n');
  await writeFile(join(dataRoot, 'icons/hicolor/scalable/apps/test-zed.svg'), nativeIcon);
  internals.catalog = {
    platform: 'linux', home: root,
    env: { DISPLAY: ':fixture', XDG_DATA_HOME: dataRoot, XDG_DATA_DIRS: dataRoot },
    resolveExecutable: async name => ['xdg-open', 'cursor', 'code', 'zed'].includes(name) ? `/fixture/bin/${name}` : null,
  };
  ctx = new Context();
  ctx.baseUrl = pathToFileURL(root).href + '/';
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]));
  ctx.provide('subprocess', { resolveExecutable: async () => { throw new Error('Fixture executable absent'); } });
  ctx.provide('connection', {
    requestRejection(req) {
      if (req.headers.origin === 'https://untrusted.invalid') return 403;
      return req.headers.authorization === headers.authorization ? undefined : 401;
    },
  });
  const configPath = join(root, 'cordis.yml');
  const rows = [
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'open-in-app', name: '@deepseek-ai/dsh-host-open-in-app', config: { probeTimeoutMs: 5000, iconTimeoutMs: 5000, launchWatchMs: 1000 } },
  ];
  if (patched) rows.push({ id: 'local-open-in-app-icons', name: '@local/dsh-open-in-app-icons', config: validConfig });
  // A JSON entry list is also valid YAML and reaches Include's ordinary file parser.
  await writeFile(configPath, JSON.stringify(rows));
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  const modules = new Map([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-host-open-in-app', OpenInApp],
    ['@local/dsh-open-in-app-icons', Icons],
  ]);
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      assert(modules.has(specifier), `Unexpected fixture import: ${specifier}`);
      return modules.get(specifier);
    },
  };
  await ctx.loader.create({ id: 'fixture', name: 'cordis:include', config: { path: pathToFileURL(configPath).href } });
  await ctx.loader.await();
  assert(ctx.webServer.port > 0);
  const base = ctx.webServer.getOrigin();
  return { ctx, base, get: (path, options = {}) => fetch(`${base}${path}`, { headers, ...options }) };
}

// Internals is the upstream test seam; cases stay sequential and restore it before another case starts.
test('unmodified upstream returns 404 for the three missing icons', async t => {
  const f = await boot(t, { patched: false });
  for (const id of validConfig.applicationIds) assert.equal((await f.get(`/open-in-app/icon/${id}`)).status, 404);
  assert.equal(await (await f.get('/open-in-app/icon/zed')).text(), nativeIcon);
});

test('configured application icons are valid cacheable images on repeated reads', async t => {
  const f = await boot(t);
  for (let pass = 0; pass < 2; pass++) {
    for (const id of validConfig.applicationIds) {
      const response = await f.get(`/open-in-app/icon/${id}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
      assert.equal(await response.text(), icon);
    }
  }
});

test('other icons, catalog, launcher, and unrelated missing resources retain upstream behavior', async t => {
  const f = await boot(t);
  const apps = (await (await f.get('/open-in-app/apps')).json()).apps;
  assert.deepEqual(new Set(apps), new Set([...validConfig.applicationIds, 'zed']));
  assert.equal(await (await f.get('/open-in-app/icon/zed')).text(), nativeIcon);
  assert.equal((await f.get('/open-in-app/icon/unknown')).status, 404);
  assert.equal((await f.get('/open-in-app/icon/filemanager/child')).status, 404);
  assert.equal((await f.get('/api/changes.summary?sessionId=absent&seq=1')).status, 404);
  assert.equal((await f.get('/open-in-app/open')).status, 405);
});

test('configured icons still reject missing authentication, untrusted origins, and non-GET methods', async t => {
  const f = await boot(t);
  for (const id of validConfig.applicationIds) {
    const path = `/open-in-app/icon/${id}`;
    assert.equal((await fetch(`${f.base}${path}`)).status, 401);
    assert.equal((await f.get(path, { headers: { ...headers, origin: 'https://untrusted.invalid' } })).status, 403);
    for (const method of ['HEAD', 'POST']) {
      const response = await f.get(path, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
    }
  }
});

test('unloading removes all exact routes and reactivation restores only their configured paths', async t => {
  const f = await boot(t);
  const entry = [...f.ctx.loader.entries()].find(row => row.id === 'fixture:local-open-in-app-icons');
  assert(entry?.fiber);
  await entry.fiber.dispose();
  for (const id of validConfig.applicationIds) assert.equal((await f.get(`/open-in-app/icon/${id}`)).status, 404);
  await f.ctx.loader.create({ id: 'icons-reloaded', name: '@local/dsh-open-in-app-icons', config: validConfig });
  await f.ctx.loader.await();
  for (const id of validConfig.applicationIds) assert.equal((await f.get(`/open-in-app/icon/${id}`)).status, 200);
  assert.equal(await (await f.get('/open-in-app/icon/zed')).text(), nativeIcon);
});

test('invalid local selection is rejected before routes are registered', async () => {
  for (const applicationIds of [[], [null], [42], ['../outside'], ['filemanager/child']]) {
    assert.throws(() => Icons.Config({ ...validConfig, applicationIds }));
  }
  assert.throws(() => Icons.Config({ applicationIds: ['filemanager'], cacheMaxAgeSeconds: -1 }));
  await assert.rejects(Icons.apply({}, { ...validConfig, applicationIds: ['filemanager', 'filemanager'] }), /duplicate ids/);
});
