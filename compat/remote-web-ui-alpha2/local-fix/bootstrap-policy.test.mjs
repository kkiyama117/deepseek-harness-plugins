import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const root = resolve(process.env.REMOTE_CHANNEL_PACKAGE ?? fileURLToPath(new URL('..', import.meta.url)));
const rendererPath = process.env.DSH_INDEX_INJECTIONS ?? '/data/softwares/deepseek-harness-upgrade-master/packages/host/webserver/lib/types/injections.js';
const { renderIndexInjections } = await import(pathToFileURL(rendererPath));
const channel = await import(pathToFileURL(`${root}/lib/types/client/remote-channel.js`));
const marker = '__DSH_REMOTE_PAIRING_POLICY__';

function uniqueSlice(text, begin, end) {
  assert.equal(text.split(begin).length, 2, `unique start: ${begin}`);
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start);
  assert.ok(finish > start, `end after start: ${end}`);
  return text.slice(start, finish);
}

for (const [name, hostPath, clientPath] of [
  ['source', 'src/index.ts', 'src/client/index.ts'],
  ['unbundled', 'lib/types/index.js', 'lib/types/client/index.js'],
  ['served', 'lib/index.js', 'lib/client.js'],
]) {
  let host = await readFile(`${root}/${hostPath}`, 'utf8');
  let client = await readFile(`${root}/${clientPath}`, 'utf8');
  if (name === 'source') {
    host = stripTypeScriptTypes(host);
    client = stripTypeScriptTypes(client);
  }
  const label = name === 'served' ? '"remote-web-ui: remote channel boot patch"' : "'remote-web-ui: remote channel boot patch'";
  const labelIndex = host.indexOf(label);
  assert.ok(labelIndex > 0);
  const beginIndex = host.lastIndexOf('ctx.effect(() => ctx.on(', labelIndex);
  assert.ok(beginIndex >= 0);
  const hook = host.slice(beginIndex, labelIndex + label.length) + ')';
  const initializer = uniqueSlice(client, 'let disposeChannel', 'const pageOrigin = pageOriginFacts(window)');

  test(`${name}: actual Host injection publishes fresh booleans before boot scripts`, () => {
    let current = { enabled: true, requirePairingForLan: true };
    let listener;
    const bootScript = `globalThis.bootSawPolicy = globalThis.${marker};`;
    const ctx = {
      effect(factory) { return factory(); },
      on(event, callback) { assert.equal(event, 'webserver/index-inject'); listener = callback; return () => {}; },
    };
    new Function('ctx', 'resolve', 'REMOTE_CHANNEL_BOOT_SCRIPT', hook)(ctx, () => current, bootScript);
    for (const [enabled, requirePairingForLan] of [[true, true], [true, false], [false, true], [false, false], [true, true]]) {
      current = { enabled, requirePairingForLan };
      const rows = [];
      listener(rows);
      const required = enabled && requirePairingForLan;
      assert.deepEqual(rows[0], { kind: 'global', name: marker, value: required });
      assert.equal(rows.length, required ? 2 : 1);
      if (required) assert.deepEqual(rows[1], { kind: 'script', placement: 'head', text: bootScript });
      const html = renderIndexInjections(`<html><head><script>globalThis.clientSawPolicy = globalThis.${marker};</script></head><body></body></html>`, rows);
      assert.ok(html.indexOf(`globalThis["${marker}"]`) < html.indexOf('globalThis.clientSawPolicy'));
      const context = {};
      for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(script, context);
      assert.equal(context.clientSawPolicy, required);
      assert.equal(context.bootSawPolicy, required ? true : undefined);
    }
  });

  for (const [description, value, snapshot, expectedRewrite] of [
    ['false marker', false, { status: 'loading' }, false],
    ['true marker', true, { status: 'loading' }, true],
    ['absent marker', undefined, { status: 'loading' }, true],
    ['invalid string marker', 'false', { status: 'loading' }, true],
    ['invalid null marker', null, { status: 'loading' }, true],
    ['ready true settings keep precedence', false, { status: 'ready', value: { enabled: true, requirePairingForLan: true } }, true],
    ['ready false settings keep precedence', true, { status: 'ready', value: { enabled: true, requirePairingForLan: false } }, false],
  ]) {
    test(`${name}: Client initial ${description}`, async () => {
      const calls = [];
      class Socket { constructor(url) { this.url = url; } }
      const window = {
        location: new URL('https://remote.example/'),
        WebSocket: Socket,
        fetch(input) { calls.push(input); return Promise.resolve({ status: 200 }); },
      };
      if (value !== undefined) window[marker] = value;
      const disposers = [];
      const ctx = { effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose; } };
      const settingsForm = { getSnapshot: () => snapshot, subscribe() {} };
      const dependencies = ['window', 'ctx', 'settingsForm', 'remoteChannelRequired', 'pageOriginFacts', 'channelTransition', 'installRemoteChannel', 'REMOTE_CHANNEL_BOOT_GLOBAL'];
      const initialize = new Function(...dependencies, `${initializer}\nreturn hostPairingPolicy;`);
      try {
        const policy = initialize(window, ctx, settingsForm, channel.remoteChannelRequired, channel.pageOriginFacts,
          channel.channelTransition, channel.installRemoteChannel, channel.REMOTE_CHANNEL_BOOT_GLOBAL);
        assert.equal(policy, typeof value === 'boolean' ? value : undefined);
        await window.fetch('/api/session/list');
        assert.equal(calls[0], expectedRewrite ? 'https://remote.example/remote/api/session/list' : '/api/session/list');
      } finally { for (const dispose of disposers.toReversed()) dispose(); }
    });
  }
}
