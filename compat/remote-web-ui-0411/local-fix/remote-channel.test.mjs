import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(process.env.REMOTE_CHANNEL_PACKAGE ?? new URL('..', import.meta.url).pathname);
const rules = await import(pathToFileURL(`${root}/lib/types/remote-channel-rules.js`));
const unbundled = await import(pathToFileURL(`${root}/lib/types/client/remote-channel.js`));
const sourceText = await readFile(`${root}/src/client/remote-channel.ts`, 'utf8');
const sourceJs = stripTypeScriptTypes(sourceText).replaceAll(
  "'../remote-channel-rules.ts'", JSON.stringify(pathToFileURL(`${root}/lib/types/remote-channel-rules.js`).href));
const source = await import(`data:text/javascript;base64,${Buffer.from(`${sourceJs}\n//# sourceURL=remote-channel-source-test.js`).toString('base64')}`);
const bundle = await readFile(`${root}/lib/client.js`, 'utf8');
const begin = '\t\t//#region src/client/remote-channel.ts';
const end = '\t\t//#region src/client/FenceNotice.tsx';
assert.equal(bundle.split(begin).length, 2, 'served channel region must be unique');
assert.equal(bundle.split(end).length, 2, 'served next region must be unique');
const region = bundle.slice(bundle.indexOf(begin), bundle.indexOf(end));
const served = new Function('REMOTE_CHANNEL_RULES', 'REMOTE_PREFIX', 'isLocalPage',
  `${region}\nreturn { installRemoteChannel, remoteChannelRequired };`)(
  rules.REMOTE_CHANNEL_RULES, rules.REMOTE_PREFIX, rules.isLocalPage);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(status, body = { error: { code: 'unpaired' } }) {
  return { status, clone: () => ({ status, json: async () => body }) };
}

function fixture(fetchResult = () => response(200)) {
  const calls = [];
  class Socket {
    constructor(url, options) { this.url = String(url); this.options = options; }
  }
  class Source extends Socket {}
  class Image {
    set src(value) { this.value = value; }
    get src() { return this.value; }
  }
  const window = {
    location: new URL('https://remote.example/'),
    sessionStorage: { getItem: () => 'offline-test-device' },
    fetch(input, init) { calls.push({ input, init, receiver: this }); return Promise.resolve(fetchResult()); },
    WebSocket: Socket,
    EventSource: Source,
    HTMLImageElement: Image,
  };
  return { window, calls, originalFetch: window.fetch };
}

for (const [name, api] of [['source', source], ['unbundled', unbundled], ['served', served]]) {
  const { installRemoteChannel, remoteChannelRequired } = api;
  for (const status of [200, 403]) {
    test(`${name}: pending fetch ${status} cannot notify after restore`, async () => {
      const network = deferred();
      const { window } = fixture(() => network.promise);
      const notices = [];
      const restore = installRemoteChannel(window, {
        onUnpaired: () => notices.push('unpaired'), onPaired: () => notices.push('paired'),
      });
      const pending = window.fetch('/api/session/list');
      restore();
      const result = response(status);
      network.resolve(result);
      assert.equal(await pending, result);
      assert.deepEqual(notices, []);
    });
  }

  for (const code of ['unpaired', 'forbidden']) {
    test(`${name}: pending response.json ${code} cannot notify after restore`, async () => {
      const jsonStarted = deferred();
      const json = deferred();
      const result = { status: 403, clone: () => ({ status: 403, json() { jsonStarted.resolve(); return json.promise; } }) };
      const { window } = fixture(() => result);
      const notices = [];
      const restore = installRemoteChannel(window, {
        onUnpaired: () => notices.push('unpaired'), onPaired: () => notices.push('paired'),
      });
      const pending = window.fetch('/api/session/list');
      await jsonStarted.promise;
      restore();
      json.resolve({ result: { error: { code } } });
      assert.equal(await pending, result);
      assert.deepEqual(notices, []);
    });
  }

  test(`${name}: current true policy rewrites and reports unpaired 403`, async () => {
    assert.equal(remoteChannelRequired({ hostname: 'remote.example', protocol: 'https:' },
      { status: 'ready', value: { enabled: true, requirePairingForLan: true } }, true), true);
    const result = response(403);
    const { window, calls } = fixture(() => result);
    const notices = [];
    const restore = installRemoteChannel(window, {
      onUnpaired: () => notices.push('unpaired'), onPaired: () => notices.push('paired'),
    });
    try {
      assert.equal(await window.fetch('/api/session/list', { headers: {} }), result);
      assert.equal(calls[0].input, 'https://remote.example/remote/api/session/list');
      assert.equal(calls[0].init.headers[rules.REMOTE_CHANNEL_RULES.deviceHeader], 'offline-test-device');
      assert.deepEqual(notices, ['unpaired']);
      await window.fetch('/api/pair/status');
      assert.equal(calls[1].input, '/api/pair/status');
      assert.deepEqual(notices, ['unpaired']);
    } finally { restore(); }
  });

  test(`${name}: current success and non-unpaired 403 retain paired callback`, async () => {
    const queue = [response(200), response(403, { error: { code: 'forbidden' } })];
    const { window } = fixture(() => queue.shift());
    const notices = [];
    const restore = installRemoteChannel(window, {
      onUnpaired: () => notices.push('unpaired'), onPaired: () => notices.push('paired'),
    });
    try {
      await window.fetch('/api/session/list');
      await window.fetch('/api/session/list');
      assert.deepEqual(notices, ['paired', 'paired']);
    } finally { restore(); }
  });

  test(`${name}: old success cannot hide new generation notice`, async () => {
    const oldNetwork = deferred();
    let first = true;
    const { window } = fixture(() => {
      if (first) { first = false; return oldNetwork.promise; }
      return response(403);
    });
    let visible = false;
    const options = { onUnpaired: () => { visible = true; }, onPaired: () => { visible = false; } };
    const retireOld = installRemoteChannel(window, options);
    const pending = window.fetch('/api/session/list');
    retireOld();
    const retireNew = installRemoteChannel(window, options);
    try {
      await window.fetch('/api/session/list');
      assert.equal(visible, true);
      oldNetwork.resolve(response(200));
      await pending;
      assert.equal(visible, true);
    } finally { retireNew(); }
  });

  test(`${name}: captured fetch after restore passes original API and init unchanged`, async () => {
    const { window, calls, originalFetch } = fixture();
    let notifications = 0;
    const restore = installRemoteChannel(window, { onPaired: () => { notifications++; } });
    const captured = window.fetch;
    restore();
    assert.equal(window.fetch, originalFetch);
    const init = { headers: { 'x-offline-test': 'value' } };
    await captured('/api/session/list', init);
    assert.equal(calls[0].input, '/api/session/list');
    assert.equal(calls[0].init, init);
    assert.equal(calls[0].receiver, window);
    assert.equal(notifications, 0);
  });

  test(`${name}: captured WebSocket and EventSource retire rewrite and device query`, () => {
    const { window } = fixture();
    const restore = installRemoteChannel(window);
    const CapturedSocket = window.WebSocket;
    const CapturedSource = window.EventSource;
    assert.equal(new URL(new CapturedSocket('wss://remote.example/api/remote.mux').url).pathname, '/remote/api/remote.mux');
    assert.equal(new URL(new CapturedSource('/api/events').url).pathname, '/remote/api/events');
    restore();
    const protocols = ['offline'];
    const socket = new CapturedSocket('wss://remote.example/api/remote.mux', protocols);
    assert.equal(socket.url, 'wss://remote.example/api/remote.mux');
    assert.equal(socket.options, protocols);
    const init = { withCredentials: true };
    const source = new CapturedSource('/api/events', init);
    assert.equal(source.url, '/api/events');
    assert.equal(source.options, init);
  });

  test(`${name}: captured resource setter stops rewriting after restore`, () => {
    const { window } = fixture();
    const restore = installRemoteChannel(window);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, 'src').set;
    const image = new window.HTMLImageElement();
    setter.call(image, '/api/image');
    assert.equal(image.src, '/remote/api/image');
    restore();
    setter.call(image, '/api/image');
    assert.equal(image.src, '/api/image');
  });

  test(`${name}: repeated old restore cannot uninstall a new generation`, async () => {
    const { window, calls } = fixture();
    const oldRestore = installRemoteChannel(window);
    oldRestore();
    const newRestore = installRemoteChannel(window);
    try {
      oldRestore();
      await window.fetch('/api/session/list');
      assert.equal(calls[0].input, 'https://remote.example/remote/api/session/list');
    } finally { newRestore(); }
  });
}
