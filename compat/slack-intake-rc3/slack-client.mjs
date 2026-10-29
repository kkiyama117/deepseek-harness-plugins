const MAX_BYTES = 2 * 1024 * 1024;
const GET_METHODS = new Set(['conversations.info', 'conversations.history', 'conversations.replies', 'reactions.get']);
const METHODS = /^(?:auth\.test|conversations\.(?:info|create|join|history|replies)|chat\.(?:postMessage|update|postEphemeral)|reactions\.get|apps\.connections\.open)$/;
// Fixed codes prevent even identifier-shaped secrets in upstream errors from escaping.
const SLACK_CODES = new Set([
  'invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive',
  'missing_scope', 'not_allowed_token_type', 'no_permission', 'access_denied',
  'channel_not_found', 'not_in_channel', 'is_archived', 'name_taken', 'invalid_name',
  'invalid_arguments', 'invalid_arg_name', 'invalid_blocks', 'invalid_json',
  'message_not_found', 'cant_update_message', 'restricted_action', 'user_not_found',
  'ratelimited', 'rate_limited', 'ekm_access_denied', 'team_access_not_granted',
  'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout',
]);
const LOCAL_CODES = new Set([
  'invalid_method', 'invalid_kind', 'invalid_input', 'invalid_config', 'token_unavailable',
  'timeout', 'cancelled', 'network_error', 'http_error', 'response_too_large',
  'invalid_response', 'slack_error', 'socket_unavailable', 'invalid_socket_url',
  'socket_error', 'socket_closed', 'socket_disconnect', 'socket_timeout',
  'socket_already_started', 'handler_failed', 'receipt_failed',
]);
const UNCERTAIN_SLACK = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);

export class SlackApiError extends Error {
  constructor(code, outcome = 'ambiguous') {
    const safe = SLACK_CODES.has(code) || LOCAL_CODES.has(code) ? code : 'slack_error';
    super(`Slack adapter: ${safe}`);
    this.name = 'SlackApiError';
    this.code = safe;
    this.outcome = ['definite', 'ambiguous', 'not_sent'].includes(outcome) ? outcome : 'ambiguous';
    this.ambiguous = this.outcome === 'ambiguous';
    this.definite = this.outcome === 'definite';
  }
}

function fail(code, outcome) { return new SlackApiError(code, outcome); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function scopes(header) {
  return typeof header === 'string' ? header.slice(0, 10000).split(',').map(s => s.trim())
    .filter(s => s.length <= 100 && /^[a-z][a-z0-9._-]*(?::[a-z0-9._-]+)*$/.test(s)).slice(0, 100) : [];
}

async function readBounded(response, signal) {
  const length = response.headers?.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw fail('response_too_large');
  }
  if (!response.body?.getReader) throw fail('invalid_response');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw fail('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { cancel(); throw fail('response_too_large'); }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks, bytes);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
    catch { throw fail('invalid_response'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Private Slack adapter. No retries; resolveToken is called afresh on every request.
 * Optional fourth argument: {signal}. inspect returns only bounded body + scope headers.
 */
export class SlackClient {
  constructor({ resolveToken, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof resolveToken !== 'function' || typeof fetchImpl !== 'function' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      throw fail('invalid_config', 'not_sent');
    }
    this.resolveToken = resolveToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async call(method, input = {}, kind = 'bot', options = {}) {
    return (await this.inspect(method, input, kind, options)).body;
  }

  async inspect(method, input = {}, kind = 'bot', { signal } = {}) {
    if (typeof method !== 'string' || !METHODS.test(method)) throw fail('invalid_method', 'not_sent');
    if (!['bot', 'app'].includes(kind)) throw fail('invalid_kind', 'not_sent');
    if (!object(input) || Object.hasOwn(input, 'token')) throw fail('invalid_input', 'not_sent');
    let body;
    try { body = JSON.stringify(input); } catch { throw fail('invalid_input', 'not_sent'); }
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES) throw fail('invalid_input', 'not_sent');
    const get = GET_METHODS.has(method);
    let endpoint = `https://slack.com/api/${method}`;
    if (get) {
      const parameters = JSON.parse(body);
      if (!object(parameters) || Object.values(parameters).some(value => !['string', 'number', 'boolean'].includes(typeof value))) throw fail('invalid_input', 'not_sent');
      const query = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)]));
      if (query.size) endpoint += '?' + query.toString();
    }
    const controller = new AbortController();
    let sent = false;
    let timer;
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => {
        controller.abort();
        reject(fail('cancelled', sent ? 'ambiguous' : 'not_sent'));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(fail('timeout', sent ? 'ambiguous' : 'not_sent'));
      }, this.timeoutMs);
    });
    const request = async () => {
      if (controller.signal.aborted) throw fail('cancelled', 'not_sent');
      let token;
      try { token = await this.resolveToken(kind); }
      catch { throw fail('token_unavailable', 'not_sent'); }
      if (controller.signal.aborted) throw fail('cancelled', 'not_sent');
      if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token)) throw fail('token_unavailable', 'not_sent');
      let response;
      try {
        sent = true;
        response = await this.fetchImpl(endpoint, {
          method: get ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, ...(!get ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
          ...(!get ? { body } : {}),
        });
      } catch { throw fail('network_error'); }
      finally { token = undefined; }
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw fail('cancelled');
      }
      // HTTP failure does not prove that a mutation was not applied. Never follow redirects.
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw fail('http_error');
      }
      let result;
      try { result = await readBounded(response, controller.signal); }
      catch (error) { throw error instanceof SlackApiError ? error : fail('network_error'); }
      if (!object(result) || typeof result.ok !== 'boolean') throw fail('invalid_response');
      if (!result.ok) {
        const code = SLACK_CODES.has(result.error) ? result.error : 'slack_error';
        // Slack documents partial success for internal_error/fatal_error even with ok:false.
        throw fail(code, UNCERTAIN_SLACK.has(code) ? 'ambiguous' : 'definite');
      }
      return { body: result, scopes: scopes(response.headers?.get('x-oauth-scopes')),
        acceptedScopes: scopes(response.headers?.get('x-accepted-oauth-scopes')) };
    };
    try { return await Promise.race([stopped, request()]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}

function socketUrl(value) {
  try {
    const url = new URL(value);
    // Slack's official apps.connections.open examples use wss.slack.com and wss-*.slack.com.
    // https://docs.slack.dev/reference/methods/apps.connections.open/
    if (url.protocol !== 'wss:' || !/^wss(?:-[a-z0-9-]+)?\.slack\.com$/.test(url.hostname) ||
        url.username || url.password || url.port || url.hash) throw new Error();
    return url.href;
  } catch { throw fail('invalid_socket_url', 'not_sent'); }
}

function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** One socket at a time, fresh connection tickets, capped 1s..30s backoff.
 * Optional beforeAck(payload): Promise<boolean> must durably persist acceptance before true.
 * False discards an invalid action after ACK; rejection leaves it unacked for Slack redelivery.
 * Caller owns fast (<3s) durable writes/replay/deduplication and handler cancellation.
 * Status is fixed metadata only; never forward socket errors, reasons, URLs or raw frames.
 */
export class SocketMode {
  constructor({ client, onInteraction, beforeAck, onStatus = () => {}, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof client?.call !== 'function' || typeof onInteraction !== 'function' || typeof onStatus !== 'function' ||
        (beforeAck !== undefined && typeof beforeAck !== 'function')) {
      throw fail('invalid_config', 'not_sent');
    }
    this.client = client;
    this.onInteraction = onInteraction;
    this.beforeAck = beforeAck;
    this.onStatus = onStatus;
    this.WebSocketImpl = WebSocketImpl;
    this.running = false;
  }

  status(metadata) {
    try { Promise.resolve(this.onStatus(metadata)).catch(() => {}); } catch { /* observer only */ }
  }

  async start(signal) {
    if (this.running) throw fail('socket_already_started', 'not_sent');
    if (!signal?.addEventListener) throw fail('invalid_config', 'not_sent');
    if (typeof this.WebSocketImpl !== 'function') throw fail('socket_unavailable', 'not_sent');
    this.running = true;
    let attempt = 0;
    try {
      while (!signal.aborted) {
        let code = 'socket_closed';
        const started = Date.now();
        try {
          const response = await this.client.call('apps.connections.open', {}, 'app', { signal });
          if (signal.aborted) break;
          code = await this.connect(socketUrl(response.url), signal);
        } catch (error) { code = error instanceof SlackApiError ? error.code : 'socket_error'; }
        if (signal.aborted) break;
        if (Date.now() - started >= 30000) attempt = 0;
        const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        attempt = Math.min(attempt + 1, 32);
        this.status({ status: 'reconnecting', code, attempt, delayMs });
        await pause(delayMs, signal);
      }
    } finally { this.running = false; this.status({ status: 'stopped' }); }
  }

  connect(url, signal) {
    return new Promise(resolve => {
      let socket;
      let timer;
      let finished = false;
      const receipts = new Set();
      const finish = code => {
        if (finished) return;
        finished = true;
        for (const cancel of receipts) cancel();
        receipts.clear();
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (socket) {
          socket.removeEventListener('open', open);
          socket.removeEventListener('message', message);
          socket.removeEventListener('close', close);
          // Keep the sanitized error sink until the closing handshake finishes.
          socket.addEventListener('close', () => socket.removeEventListener('error', error), { once: true });
          try { socket.close(); } catch { /* no raw error */ }
        }
        resolve(code);
      };
      const abort = () => finish('cancelled');
      const open = () => { clearTimeout(timer); this.status({ status: 'connected' }); };
      const close = () => finish('socket_closed');
      const error = () => finish('socket_error');
      // Cancel transport-side waits on abort/close, without cancelling the caller's disk write.
      const receipt = payload => new Promise((resolve, reject) => {
        const cancel = () => { receipts.delete(cancel); resolve(undefined); };
        receipts.add(cancel);
        Promise.resolve().then(() => {
          if (!finished && !signal.aborted) return this.beforeAck(payload);
        }).then(value => { receipts.delete(cancel); resolve(value); },
          () => { receipts.delete(cancel); reject(fail('receipt_failed')); });
      });
      const message = event => {
        if (finished || signal.aborted || typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_BYTES) return;
        let envelope;
        try { envelope = JSON.parse(event.data); } catch { return; }
        if (!object(envelope)) return;
        const validId = typeof envelope.envelope_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(envelope.envelope_id);
        if (!validId && envelope.type !== 'disconnect' && envelope.type !== 'hello') return;
        const interactive = validId && envelope.type === 'interactive' && envelope.payload?.type === 'block_actions';
        const ack = () => {
          try { socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); return true; }
          catch { finish('socket_error'); return false; }
        };
        const dispatch = () => {
          Promise.resolve().then(() => {
            if (!signal.aborted) return this.onInteraction(envelope.payload);
          }).catch(() => this.status({ status: 'interaction_error', code: 'handler_failed' }));
        };
        if (interactive && this.beforeAck) {
          receipt(envelope.payload).then(accepted => {
            if (finished || signal.aborted) return;
            if (typeof accepted !== 'boolean') throw fail('receipt_failed');
            if (ack() && accepted) dispatch();
          }).catch(() => {
            if (!finished && !signal.aborted) this.status({ status: 'receipt_failed', code: 'receipt_failed' });
          });
          return;
        }
        // Without the hook (and for unknown events), preserve immediate ACK behavior.
        if (validId && !ack()) return;
        if (envelope.type === 'disconnect') { finish('socket_disconnect'); return; }
        if (interactive) dispatch();
      };
      try {
        socket = new this.WebSocketImpl(url);
        socket.addEventListener('open', open);
        socket.addEventListener('message', message);
        socket.addEventListener('close', close);
        socket.addEventListener('error', error);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish('socket_timeout'), 15000);
        if (signal.aborted) abort();
      } catch { finish('socket_error'); }
    });
  }
}
