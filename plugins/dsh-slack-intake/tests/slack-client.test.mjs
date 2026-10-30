import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlackClient, SlackApiError, SocketMode } from '../slack-client.mjs';

const response = (body, init) => new Response(JSON.stringify(body), init);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const errorIs = (code, outcome) => error => {
  assert.ok(error instanceof SlackApiError);
  assert.equal(error.code, code);
  assert.equal(error.outcome, outcome);
  assert.equal(error.ambiguous, outcome === 'ambiguous');
  assert.equal(error.definite, outcome === 'definite');
  assert.doesNotMatch(JSON.stringify(error) + error.stack, /secret|xoxb|https:\/\//);
  return true;
};

for (const method of ['auth.test', 'conversations.info', 'conversations.create', 'conversations.join',
  'chat.postMessage', 'chat.update', 'chat.postEphemeral', 'conversations.history',
  'conversations.replies', 'reactions.get', 'apps.connections.open']) {
  test(`fixed endpoint permits ${method}, requests fresh token, never retries`, async () => {
    const calls = [];
    const kinds = [];
    const client = new SlackClient({ resolveToken: async kind => { kinds.push(kind); return `fixture-${kinds.length}`; },
      fetchImpl: async (url, options) => { calls.push([url, options]); return response({ ok: true, id: 'local' }); } });
    assert.equal((await client.call(method, { channel: 'CLOCAL' })).id, 'local');
    await client.call(method, {}, 'app');
    assert.deepEqual(kinds, ['bot', 'app']);
    assert.equal(calls.length, 2);
    const get = ['conversations.info', 'conversations.history', 'conversations.replies', 'reactions.get'].includes(method);
    const endpoint = new URL(calls[0][0]);
    assert.equal(endpoint.origin, 'https://slack.com');
    assert.equal(endpoint.pathname, `/api/${method}`);
    assert.equal(calls[0][1].redirect, 'error');
    assert.equal(calls[0][1].method, get ? 'GET' : 'POST');
    assert.equal(calls[0][1].headers.Authorization, 'Bearer fixture-1');
    assert.equal(calls[1][1].headers.Authorization, 'Bearer fixture-2');
    if (get) {
      assert.equal(endpoint.searchParams.get('channel'), 'CLOCAL');
      assert.equal(calls[0][1].body, undefined);
      assert.equal(endpoint.searchParams.has('token'), false);
    } else assert.deepEqual(JSON.parse(calls[0][1].body), { channel: 'CLOCAL' });
  });
}

test('read requests encode scalar query arguments and reject arrays before transport', async () => {
  let url; let count = 0;
  const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async endpoint => { count++; url = new URL(endpoint); return response({ ok: true }); } });
  await client.call('conversations.info', { channel: 'CLOCAL', include_locale: false });
  assert.equal(url.searchParams.get('include_locale'), 'false');
  assert.equal(url.searchParams.get('channel'), 'CLOCAL');
  await assert.rejects(client.call('conversations.info', { channel: ['CLOCAL'] }), errorIs('invalid_input', 'not_sent'));
  assert.equal(count, 1);
});

test('inspect returns bounded scope headers without token or arbitrary headers', async () => {
  const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => response({ ok: true }, {
    headers: { 'x-oauth-scopes': 'chat:write, channels:read, <bad>', 'x-accepted-oauth-scopes': 'chat:write',
      'authorization': 'secret' },
  }) });
  assert.deepEqual(await client.inspect('auth.test'), {
    body: { ok: true }, scopes: ['chat:write', 'channels:read'], acceptedScopes: ['chat:write'],
  });
});

test('invalid method/input/kind and bad token never reach transport', async () => {
  let resolutions = 0;
  const client = new SlackClient({ resolveToken: async () => { resolutions++; return 'secret\r\nheader'; },
    fetchImpl: async () => assert.fail('unexpected fetch') });
  for (const method of ['https://attacker/auth.test', 'auth.test/evil', 'users.list', 'auth.test\n', null]) {
    await assert.rejects(client.call(method), errorIs('invalid_method', 'not_sent'));
  }
  await assert.rejects(client.call('auth.test', {}, 'secret'), errorIs('invalid_kind', 'not_sent'));
  await assert.rejects(client.call('auth.test', { token: 'secret' }), errorIs('invalid_input', 'not_sent'));
  await assert.rejects(client.call('auth.test', null), errorIs('invalid_input', 'not_sent'));
  await assert.rejects(client.call('auth.test', { toJSON: () => undefined }), errorIs('invalid_input', 'not_sent'));
  const circular = {}; circular.self = circular;
  await assert.rejects(client.call('auth.test', circular), errorIs('invalid_input', 'not_sent'));
  await assert.rejects(client.call('auth.test'), errorIs('token_unavailable', 'not_sent'));
  assert.equal(resolutions, 1);
});

test('credential resolver failures are sanitized and not sent', async () => {
  const client = new SlackClient({ resolveToken: async () => { throw new Error('secret xoxb https://evil'); },
    fetchImpl: async () => assert.fail('unexpected fetch') });
  await assert.rejects(client.call('auth.test'), errorIs('token_unavailable', 'not_sent'));
});

for (const [code, outcome] of [['missing_scope', 'definite'], ['internal_error', 'ambiguous'],
  ['fatal_error', 'ambiguous'], ['service_unavailable', 'ambiguous'], ['request_timeout', 'ambiguous'],
  ['secret_xoxb_identifier', 'definite']]) {
  test(`Slack ok:false ${code} has safe ${outcome} outcome without retries`, async () => {
    let count = 0;
    const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => {
      count++; return response({ ok: false, error: code, detail: 'secret' });
    } });
    await assert.rejects(client.call('chat.postMessage'), errorIs(code.startsWith('secret') ? 'slack_error' : code, outcome));
    assert.equal(count, 1);
  });
}

for (const status of [302, 400, 429, 500, 503]) {
  test(`HTTP ${status} is ambiguous and does not retry/read raw response`, async () => {
    let count = 0;
    const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => {
      count++; return new Response('secret', { status, headers: { location: 'https://evil/secret' } });
    } });
    await assert.rejects(client.call('chat.postMessage'), errorIs('http_error', 'ambiguous'));
    assert.equal(count, 1);
  });
}

test('network exception is ambiguous, sanitized and not retried', async () => {
  let count = 0;
  const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => {
    count++; throw new Error('secret xoxb https://evil');
  } });
  await assert.rejects(client.call('conversations.history'), errorIs('network_error', 'ambiguous'));
  assert.equal(count, 1);
});

for (const value of ['secret', '{', 'null', '[]', '{}', '{"ok":"true"}']) {
  test(`malformed/unexpected response ${value} is ambiguous`, async () => {
    const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => new Response(value) });
    await assert.rejects(client.call('chat.update'), errorIs('invalid_response', 'ambiguous'));
  });
}

test('response exactly at 2 MiB passes and larger streaming content is cancelled', async () => {
  const limit = 2 * 1024 * 1024;
  const prefix = '{"ok":true,"data":"';
  const suffix = '"}';
  const exact = prefix + 'a'.repeat(limit - prefix.length - suffix.length) + suffix;
  const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => new Response(exact) });
  assert.equal((await client.call('conversations.history')).data.length, limit - prefix.length - suffix.length);
  let cancelled = false;
  client.fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(client.call('conversations.replies'), errorIs('response_too_large', 'ambiguous'));
  assert.equal(cancelled, true);
});

test('oversized declared response is cancelled before reading', async () => {
  let cancelled = false;
  const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }) });
  await assert.rejects(client.call('auth.test'), errorIs('response_too_large', 'ambiguous'));
  assert.equal(cancelled, true);
});

test('deadline bounds a non-cooperative fetch and aborts its signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const client = new SlackClient({ resolveToken: async () => 'fixture', timeoutMs: 15,
    fetchImpl: async (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  const pending = client.call('chat.postMessage');
  const rejection = assert.rejects(pending, errorIs('timeout', 'ambiguous'));
  await flush();
  t.mock.timers.tick(15);
  await rejection;
  assert.equal(signal.aborted, true);
});

test('deadline includes credential resolution and never sends a late resolved token', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const client = new SlackClient({ resolveToken: () => new Promise(r => { resolve = r; }), timeoutMs: 15,
    fetchImpl: async () => assert.fail('late token was sent') });
  const rejection = assert.rejects(client.call('auth.test'), errorIs('timeout', 'not_sent'));
  t.mock.timers.tick(15);
  await rejection;
  resolve('fixture');
  await flush();
});

test('caller cancellation before send and during body read is bounded', async () => {
  const before = new AbortController(); before.abort('secret');
  const client = new SlackClient({ resolveToken: async () => 'fixture', fetchImpl: async () => assert.fail('aborted request sent') });
  await assert.rejects(client.call('auth.test', {}, 'bot', { signal: before.signal }), errorIs('cancelled', 'not_sent'));
  let cancelled = false;
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  client.fetchImpl = async () => new Response(new ReadableStream({
    pull() { started(); }, cancel() { cancelled = true; },
  }));
  const during = new AbortController();
  const rejection = assert.rejects(client.call('chat.update', {}, 'bot', { signal: during.signal }), errorIs('cancelled', 'ambiguous'));
  await reading;
  during.abort('secret');
  await rejection;
  assert.equal(cancelled, true);
});

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url) { super(); this.url = url; this.sent = []; this.closed = false; FakeSocket.instances.push(this); }
  emit(type, data) { const event = new Event(type); if (data !== undefined) event.data = data; this.dispatchEvent(event); }
  frame(data) { this.emit('message', typeof data === 'string' ? data : JSON.stringify(data)); }
  send(data) { if (this.closed) throw new Error('secret'); this.sent.push(JSON.parse(data)); }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
function socketFixture(url = 'wss://wss-primary.slack.com/link/?ticket=secret', { beforeAck } = {}) {
  FakeSocket.instances = [];
  const calls = [];
  const interactions = [];
  const statuses = [];
  const controller = new AbortController();
  const socket = new SocketMode({ client: { call: async (...args) => { calls.push(args); return { ok: true, url }; } },
    WebSocketImpl: FakeSocket, beforeAck, onInteraction: async payload => { interactions.push(payload); }, onStatus: status => statuses.push(status) });
  return { socket, controller, calls, interactions, statuses };
}

test('Socket Mode acks before handler, drops unknown/malformed input and closes on abort', async () => {
  const f = socketFixture();
  const order = [];
  f.socket.onInteraction = payload => { order.push('handler'); f.interactions.push(payload); return new Promise(() => {}); };
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0];
  assert.deepEqual(f.calls[0].slice(0, 3), ['apps.connections.open', {}, 'app']);
  assert.equal(f.calls[0][3].signal, f.controller.signal);
  ws.emit('open');
  ws.frame({ type: 'interactive', envelope_id: 'envelope-1', payload: { type: 'block_actions' } });
  order.push('acked');
  assert.deepEqual(ws.sent, [{ envelope_id: 'envelope-1' }]);
  assert.deepEqual(order, ['acked']);
  await flush();
  assert.deepEqual(order, ['acked', 'handler']);
  ws.frame({ type: 'events_api', envelope_id: 'envelope-2', payload: { type: 'block_actions' } });
  ws.frame({ type: 'interactive', envelope_id: 'envelope-3', payload: { type: 'view_submission' } });
  ws.frame({ type: 'interactive', payload: { type: 'block_actions' } });
  ws.frame('{secret');
  ws.frame({ type: 'interactive', envelope_id: '<secret>', payload: { type: 'block_actions' } });
  ws.frame('a'.repeat(2 * 1024 * 1024 + 1));
  await flush();
  assert.equal(ws.sent.length, 3);
  assert.equal(f.interactions.length, 1);
  f.controller.abort();
  await pending; // does not wait on the caller-owned never-settling handler
  assert.equal(ws.closed, true);
  assert.deepEqual(f.statuses, [{ status: 'connected' }, { status: 'stopped' }]);
});

for (const url of ['wss://wss.slack.com/link/?ticket=secret', 'wss://wss-primary.slack.com/link', 'wss://wss-111.slack.com/link']) {
  test(`Socket Mode permits documented Slack host ${new URL(url).hostname}`, async () => {
    const f = socketFixture(url); const pending = f.socket.start(f.controller.signal);
    await flush(); assert.equal(FakeSocket.instances.length, 1);
    f.controller.abort(); await pending;
  });
}

for (const url of ['ws://wss.slack.com/link', 'wss://wss.slack.com.evil/link', 'wss://wss.evil/link',
  'wss://secret@wss.slack.com/link', 'wss://wss.slack.com:444/link', 'wss://slack.com/link',
  'https://wss-primary.slack.com/link', 'wss://wss.slack.com/link#secret']) {
  test(`Socket Mode rejects non-approved URL variant without leaking it`, async () => {
    const f = socketFixture(url);
    const pending = f.socket.start(f.controller.signal);
    await flush();
    assert.equal(FakeSocket.instances.length, 0);
    assert.equal(f.statuses[0].code, 'invalid_socket_url');
    assert.doesNotMatch(JSON.stringify(f.statuses), /secret|wss:/);
    f.controller.abort(); await pending;
  });
}

test('hard disconnect creates new ticket after bounded backoff without replaying handlers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = socketFixture();
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  ws.frame({ type: 'interactive', envelope_id: 'first', payload: { type: 'block_actions' } });
  await flush();
  ws.frame({ type: 'disconnect', reason: 'secret', debug_info: { host: 'secret' } });
  await flush();
  assert.equal(ws.closed, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.statuses.at(-1), { status: 'reconnecting', code: 'socket_disconnect', attempt: 1, delayMs: 1000 });
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.interactions.length, 1);
  FakeSocket.instances[1].close(); await flush();
  assert.equal(f.statuses.at(-1).delayMs, 2000);
  f.controller.abort(); await pending;
  t.mock.timers.tick(100000); await flush();
  assert.equal(f.calls.length, 2);
});

test('socket errors, handshake timeout, handler errors and ticket errors are sanitized', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = socketFixture();
  f.socket.onInteraction = async () => { throw new Error('secret'); };
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  ws.frame({ type: 'interactive', envelope_id: 'one', payload: { type: 'block_actions' } });
  await flush();
  assert.equal(f.statuses.at(-1).code, 'handler_failed');
  ws.emit('error', 'secret'); await flush();
  assert.equal(f.statuses.at(-1).code, 'socket_error');
  t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(15000); await flush();
  assert.equal(f.statuses.at(-1).code, 'socket_timeout');
  f.socket.client.call = async () => { throw new Error('secret https://evil'); };
  t.mock.timers.tick(2000); await flush();
  assert.equal(f.statuses.at(-1).code, 'socket_error');
  assert.doesNotMatch(JSON.stringify(f.statuses), /secret|https|ticket/);
  f.controller.abort(); await pending;
});

test('connection backoff caps at 30 seconds; aborted start and duplicate start do not leak sockets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = socketFixture();
  f.socket.client.call = async () => { throw new Error('secret'); };
  const pending = f.socket.start(f.controller.signal);
  await flush();
  await assert.rejects(f.socket.start(f.controller.signal), errorIs('socket_already_started', 'not_sent'));
  const delays = [];
  for (let i = 0; i < 8; i++) {
    const delay = f.statuses.at(-1).delayMs;
    delays.push(delay); t.mock.timers.tick(delay); await flush();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  f.controller.abort(); await pending;
  await f.socket.start(f.controller.signal);
  assert.equal(FakeSocket.instances.length, 0);
});

test('durable beforeAck must finish true before ACK and handler dispatch', async () => {
  let save;
  const order = [];
  const payload = { type: 'block_actions', fixture: 'decision' };
  const f = socketFixture(undefined, { beforeAck: received => {
    assert.deepEqual(received, payload);
    return new Promise(resolve => { save = () => { order.push('saved'); resolve(true); }; });
  } });
  f.socket.onInteraction = async received => {
    assert.deepEqual(received, payload);
    order.push('handler');
    assert.equal(FakeSocket.instances[0].sent.length, 1);
    f.interactions.push(received);
  };
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  const send = ws.send.bind(ws);
  ws.send = data => { order.push('acked'); send(data); };
  ws.frame({ type: 'interactive', envelope_id: 'durable-1', payload });
  await flush();
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(f.interactions, []);
  assert.deepEqual(order, []);
  save(); await flush();
  assert.deepEqual(order, ['saved', 'acked', 'handler']);
  assert.deepEqual(ws.sent, [{ envelope_id: 'durable-1' }]);
  assert.equal(f.interactions.length, 1);
  f.controller.abort(); await pending;
});

for (const beforeAck of [async () => { throw new Error('secret https://evil'); },
  () => { throw new Error('secret'); }, async () => undefined]) {
  test('receipt rejection or invalid result leaves envelope unacked with safe status', async () => {
    const f = socketFixture(undefined, { beforeAck });
    const pending = f.socket.start(f.controller.signal);
    await flush();
    const ws = FakeSocket.instances[0]; ws.emit('open');
    ws.frame({ type: 'interactive', envelope_id: 'receipt-fails', payload: { type: 'block_actions' } });
    await flush();
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(f.interactions, []);
    assert.deepEqual(f.statuses.at(-1), { status: 'receipt_failed', code: 'receipt_failed' });
    assert.doesNotMatch(JSON.stringify(f.statuses), /secret|https/);
    assert.equal(new SlackApiError('receipt_failed').code, 'receipt_failed');
    f.controller.abort(); await pending;
  });
}

test('beforeAck false acknowledges rejected actions but never dispatches handler', async () => {
  const f = socketFixture(undefined, { beforeAck: async () => false });
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  ws.frame({ type: 'interactive', envelope_id: 'rejected', payload: { type: 'block_actions' } });
  await flush();
  assert.deepEqual(ws.sent, [{ envelope_id: 'rejected' }]);
  assert.deepEqual(f.interactions, []);
  assert.deepEqual(f.statuses, [{ status: 'connected' }]);
  f.controller.abort(); await pending;
});

test('beforeAck only gates block actions; unknown events still ACK immediately', async () => {
  let receipts = 0;
  const f = socketFixture(undefined, { beforeAck: async () => { receipts++; return true; } });
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  ws.frame({ type: 'events_api', envelope_id: 'other-event', payload: { type: 'block_actions' } });
  ws.frame({ type: 'interactive', envelope_id: 'other-action', payload: { type: 'view_submission' } });
  ws.frame({ type: 'interactive', payload: { type: 'block_actions' } });
  assert.deepEqual(ws.sent, [{ envelope_id: 'other-event' }, { envelope_id: 'other-action' }]);
  await flush();
  assert.equal(receipts, 0);
  assert.equal(f.interactions.length, 0);
  f.controller.abort(); await pending;
});

test('abort immediately after durable save preserves inbox without ACK or handler', async () => {
  const durableInbox = new Map(); // Stub: only the parent bridge can prove real fsync persistence.
  const f = socketFixture(undefined, { beforeAck: async payload => {
    durableInbox.set('stable-action', structuredClone(payload));
    f.controller.abort(); // unload between durable receipt and ACK
    return true;
  } });
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  const payload = { type: 'block_actions', fixture: 'saved-decision' };
  ws.frame({ type: 'interactive', envelope_id: 'saved-before-abort', payload });
  await pending; await flush();
  assert.deepEqual(durableInbox.get('stable-action'), payload);
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(f.interactions, []);
  assert.equal(ws.closed, true);
  assert.equal(f.statuses.at(-1).status, 'stopped');
});

test('abort cleans up pending receipt wait without late ACK/handler or status', async () => {
  let save;
  const f = socketFixture(undefined, { beforeAck: () => new Promise(resolve => { save = resolve; }) });
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  ws.frame({ type: 'interactive', envelope_id: 'pending-receipt', payload: { type: 'block_actions' } });
  await flush();
  assert.deepEqual(ws.sent, []);
  f.controller.abort(); await pending;
  save(true); await flush();
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(f.interactions, []);
  assert.deepEqual(f.statuses, [{ status: 'connected' }, { status: 'stopped' }]);
});

test('closing socket during receipt wait prevents a late ACK on the retired socket', async () => {
  let save;
  const f = socketFixture(undefined, { beforeAck: () => new Promise(resolve => { save = resolve; }) });
  const pending = f.socket.start(f.controller.signal);
  await flush();
  const ws = FakeSocket.instances[0]; ws.emit('open');
  ws.frame({ type: 'interactive', envelope_id: 'retired-receipt', payload: { type: 'block_actions' } });
  await flush();
  ws.close(); await flush();
  save(true); await flush();
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(f.interactions, []);
  assert.equal(f.statuses.at(-1).code, 'socket_closed');
  f.controller.abort(); await pending;
});
