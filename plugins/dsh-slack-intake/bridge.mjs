/** Slack is a replaceable UI. Go owns decisions/jobs; this Host owns one socket and Worker. */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, readdir, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SlackClient, SocketMode } from './slack-client.mjs';
import { buildReferenceCard, buildDigestHeader, buildJobResult, parsePolicyAction } from './slack-cards.mjs';
import { callManagement, acquireWorkerLock, atomicJSON, readJSON, AutomationError } from './automation-client.mjs';
import { executeVerification } from './verification-runtime.mjs';

export const name = 'slack-intake-bridge';
export const inject = ['credentials', 'agents', 'agentPresets', 'tools', 'systemPrompt', 'sessions'];
const hash = value => createHash('sha256').update(value).digest('hex');
export function resolveBridgeConfig(config) {
  for (const key of ['aistoreExecutable', 'storeRoot', 'stateHome', 'bridgeStateRoot', 'targetRoot', 'artifactsRoot']) if (!isAbsolute(config[key] ?? '')) throw new Error(`slack-intake-bridge: invalid ${key}`);
  for (const [key, pattern] of [['teamId', /^T[A-Z0-9]+$/], ['channelId', /^C[A-Z0-9]+$/]]) if (!pattern.test(config[key] ?? '')) throw new Error(`slack-intake-bridge: invalid ${key}`);
  if (!Array.isArray(config.allowedUsers) || config.allowedUsers.some(id => !/^[UW][A-Z0-9]+$/.test(id))) throw new Error('slack-intake-bridge: explicit allowedUsers required');
  if (!config.presetId || !['provider', 'model', 'reasoningEffort'].every(k => typeof config.route?.[k] === 'string' && config.route[k])) throw new Error('slack-intake-bridge: explicit preset and route required');
  for (const key of ['pollSeconds', 'jobTimeoutSeconds', 'maxModelSteps']) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`slack-intake-bridge: invalid ${key}`);
  if (!Number.isSafeInteger(config.route.maxTokens) || config.route.maxTokens < 1) throw new Error('slack-intake-bridge: maxTokens required');
  if (config.verificationPurpose !== undefined && !['article-review', 'project-experiment'].includes(config.verificationPurpose)) throw new Error('slack-intake-bridge: invalid verificationPurpose');
  if (config.verificationPurpose === 'project-experiment' && !config.intendedUse?.trim()) throw new Error('slack-intake-bridge: project experiments require an explicit intendedUse');
  return { ...config, verificationPurpose: config.verificationPurpose ?? 'article-review', botCredential: config.botCredential ?? 'SLACK_BOT_TOKEN', appCredential: config.appCredential ?? 'SLACK_INTAKE_APP_TOKEN' };
}
export class SlackIntakeBridge {
  constructor(ctx, config, { management = callManagement, execute = executeVerification, client, socketFactory } = {}) {
    this.ctx = ctx; this.config = resolveBridgeConfig(config); this.management = management; this.execute = execute;
    this.client = client ?? new SlackClient({ resolveToken: async kind => (await ctx.credentials.resolve(credentialRef(kind === 'app' ? this.config.appCredential : this.config.botCredential)))?.value });
    this.socketFactory = socketFactory ?? (opts => new SocketMode(opts));
    this.status = { phase: 'starting', socket: 'offline', missing: [], last_error: null, last_job: null };
    this.serial = Promise.resolve(); this.interactions = Promise.resolve(); this.managementSerial = Promise.resolve();
  }
  managementCall(request, options = {}) {
    const task = this.managementSerial.then(() => {
      if (options.signal?.aborted) throw new AutomationError('INTERRUPTED');
      return this.management(this.config, request, options);
    });
    this.managementSerial = task.catch(() => {}); return task;
  }
  async saveStatus() { await atomicJSON(join(this.config.bridgeStateRoot, 'status.json'), { ...this.status, updated_at: new Date().toISOString() }); }
  async persist() { await atomicJSON(join(this.config.bridgeStateRoot, 'delivery.json'), this.ledger); }
  enqueue(fn) { const task = this.serial.then(fn); this.serial = task.catch(() => {}); return task; }
  automation(request, signal) { return this.managementCall(request, { signal }); }
  async readiness(signal) {
    const missing = [];
    for (const [key, name] of [['bot', this.config.botCredential], ['app', this.config.appCredential]]) {
      if (!(await this.ctx.credentials.describe(credentialRef(name))).configured) missing.push(name);
    }
    if (!this.config.allowedUsers.length) missing.push('allowedUsers');
    if (missing.includes(this.config.botCredential)) return missing;
    const auth = await this.client.inspect('auth.test', {}, 'bot', { signal });
    if (auth.body.team_id !== this.config.teamId) throw new AutomationError('SLACK_WORKSPACE_MISMATCH');
    this.botUserId = auth.body.user_id;
    if (!auth.scopes.includes('chat:write')) missing.push('scope:chat:write');
    if (!auth.scopes.includes('channels:read')) missing.push('scope:channels:read');
    if (!missing.includes('scope:channels:read')) {
      const channel = await this.client.call('conversations.info', { channel: this.config.channelId }, 'bot', { signal });
      if (channel.channel?.id !== this.config.channelId || channel.channel?.is_archived) throw new AutomationError('SLACK_CHANNEL_MISMATCH');
      if (!channel.channel.is_member) missing.push('invite-bot-to-channel');
    }
    return missing;
  }
  async postOnce(key, input, signal) {
    const previous = this.ledger.deliveries[key];
    if (previous?.status === 'sent') return previous;
    if (previous && ['sending', 'unknown'].includes(previous.status)) return null;
    if (this.postBudget !== undefined && this.postBudget <= 0) return null;
    const wait = Math.max(0, (this.nextPostAt ?? 0) - Date.now());
    if (wait) await delay(wait, undefined, { signal });
    this.nextPostAt = Date.now() + 1000;
    if (this.postBudget !== undefined) this.postBudget--;
    const entry = { status: 'sending', client_msg_id: previous?.client_msg_id ?? randomUUID(), ts: '', thread_ts: input.thread_ts ?? '' };
    this.ledger.deliveries[key] = entry; await this.persist();
    try {
      const result = await this.client.call('chat.postMessage', { channel: this.config.channelId, ...input, client_msg_id: entry.client_msg_id, unfurl_links: false, unfurl_media: false }, 'bot', { signal });
      if (typeof result.ts !== 'string') throw new AutomationError('POST_OUTCOME_UNKNOWN');
      entry.status = 'sent'; entry.ts = result.ts; await this.persist(); return entry;
    } catch (error) {
      entry.status = error.outcome === 'definite' || error.outcome === 'not_sent' ? 'failed' : 'unknown';
      entry.error = error.code ?? 'POST_FAILED'; await this.persist(); throw error;
    }
  }
  async publishReference(reference, threadTs, signal) {
    const key = 'card:' + hash(reference.identity);
    const decision = await this.automation({ action: 'policy-get', identity: reference.identity }, signal);
    const card = buildReferenceCard({ ...reference, identity: key }, decision, { targetLabel: this.config.verificationPurpose === 'project-experiment' ? this.config.intendedUse : '資料の用途確認（実験先は未指定）' });
    const delivery = await this.postOnce(key, { ...card, thread_ts: threadTs }, signal);
    if (delivery) { this.ledger.cards[key] = { identity: reference.identity, ts: delivery.ts, thread_ts: threadTs }; await this.persist(); }
    return delivery;
  }
  async publishIntakeAttention(signal) {
    const snapshot = await this.managementCall({ action: 'snapshot' }, { operation: 'organize', signal });
    const batch = snapshot.batches.find(batch => batch.status === 'needs_attention');
    if (!batch) return;
    const reason = /^DAILY_[A-Z_]+$/.test(batch.reason ?? '') ? batch.reason : '未完了';
    const text = `取り込みは要対応です。${new Date(batch.created_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}開始分：${reason}。表示済みの日報は最新の完了分です。結果不明の処理を勝手に再実行していません。`;
    await this.postOnce('intake-attention:' + batch.batch_id + ':' + reason, { text, blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }] }, signal);
  }
  async publishDigest(signal) {
    const cursor = this.ledger.digest_cursor;
    const page = await this.automation({ action: 'digest-batches', ...(cursor ? { after_updated_at: cursor.updated_at, after_batch_id: cursor.batch_id } : { latest: true }) }, signal);
    // Bootstrap with one latest completed report; subsequent polls use the complete
    // delivery cursor, not the GUI's bounded 30-row history.
    for (const batch of page.batches) {
      const digest = await this.automation({ action: 'digest', batch_id: batch.batch_id }, signal);
      if (!digest || digest.batch.status !== 'completed') continue;
      const header = buildDigestHeader({ date: new Date(batch.created_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }), newCount: digest.counts.newly_registered, heldCount: digest.counts.held, status: digest.counts.held || digest.counts.pending ? '要対応' : '完了' });
      const delivery = await this.postOnce('digest:' + batch.batch_id, header, signal);
      if (!delivery) return;
      for (const reference of digest.references) if (!await this.publishReference(reference, delivery.ts, signal)) return;
      this.ledger.digest_cursor = { updated_at: batch.updated_at, batch_id: batch.batch_id };
      await this.persist();
      this.status.latest_batch = batch.batch_id;
    }
  }
  async refreshCard(key, reference, signal, resultText = '') {
    const binding = this.ledger.cards[key];
    if (!binding) return;
    const decision = await this.automation({ action: 'policy-get', identity: binding.identity }, signal);
    const card = buildReferenceCard({ ...reference, identity: key }, decision, { targetLabel: this.config.verificationPurpose === 'project-experiment' ? this.config.intendedUse : '資料の用途確認（実験先は未指定）', resultText });
    await this.client.call('chat.update', { channel: this.config.channelId, ts: binding.ts, ...card }, 'bot', { signal });
  }
  decisionReceipt(payload) {
    const action = parsePolicyAction(payload, { teamId: this.config.teamId, channelId: this.config.channelId, allowedUsers: this.config.allowedUsers, botUserId: this.botUserId });
    const binding = this.ledger.cards[action.identity];
    if (!binding || binding.deleted || binding.ts !== action.messageTs) throw new AutomationError('UNKNOWN_CARD');
    return { version: 1, received_at: new Date().toISOString(), card_key: action.identity, message_ts: action.messageTs, request: { action: 'decision-submit', identity: binding.identity, usage_policy: action.policy, expected_version: action.version, request_id: action.requestId, actor: action.actor, ...(action.policy === 'verify-now' ? { target: this.config.targetRoot, workflow: 'development-verification' } : {}) } };
  }
  async acceptInteraction(payload) {
    let receipt;
    try { receipt = this.decisionReceipt(payload); } catch { return false; }
    const root = join(this.config.bridgeStateRoot, 'inbox');
    const filename = receipt.request.request_id + '.json';
    if (await readJSON(join(root, 'accepted', filename), null) || await readJSON(join(root, 'pending', filename), null)) return true;
    // This fsync+rename completes BEFORE the Socket Mode ACK. No raw Slack body,
    // credential, response URL or source text is stored in the receiver inbox.
    await atomicJSON(join(root, 'pending', filename), receipt);
    return true;
  }
  async optionalCardRefresh(key, reference, signal, text) {
    try { await this.refreshCard(key, reference, signal, text); }
    catch (error) {
      this.status.last_error = error.code ?? 'CARD_REFRESH_FAILED';
      if (error.code === 'message_not_found' && this.ledger.cards[key]) { this.ledger.cards[key].deleted = true; await this.persist(); }
    }
  }
  async applyReceipt(receipt, signal) {
    const request = receipt.request;
    const binding = this.ledger.cards[receipt.card_key];
    if (!binding || binding.identity !== request.identity || !this.config.allowedUsers.some(id => request.actor === `slack:${this.config.teamId}:${id}`)) throw new AutomationError('RECEIPT_UNAUTHORIZED');
    if (request.usage_policy === 'verify-now' && request.target !== this.config.targetRoot) throw new AutomationError('TARGET_MISMATCH');
    let decision;
    try { decision = await this.automation(request, signal); }
    catch (error) {
      const latest = await this.managementCall({ action: 'snapshot' }, { operation: 'organize', signal });
      await this.optionalCardRefresh(receipt.card_key, latest.references.find(r => r.identity === request.identity), signal, '方針を保存できませんでした。最新状態を表示しています。内容を確認して選び直してください。');
      throw error;
    }
    await this.automation({ action: 'sync' }, signal);
    const snapshot = await this.managementCall({ action: 'snapshot' }, { operation: 'organize', signal });
    await this.optionalCardRefresh(receipt.card_key, snapshot.references.find(r => r.identity === request.identity), signal, decision.job_id ? '検証依頼を保存しました。順次実行します。' : '活用方針を保存しました。');
    this.status.last_decision = { identity: request.identity, policy: decision.usage_policy, job_id: decision.job_id || null };
    await this.saveStatus(); return decision;
  }
  async handleInteraction(payload, signal) { return this.applyReceipt(this.decisionReceipt(payload), signal); }
  async drainInbox(signal) {
    const root = join(this.config.bridgeStateRoot, 'inbox');
    await mkdir(join(root, 'accepted'), { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'pending'), { recursive: true, mode: 0o700 });
    const names = (await readdir(join(root, 'pending'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const receipts = await Promise.all(names.map(async filename => ({ filename, receipt: await readJSON(join(root, 'pending', filename), null) })));
    receipts.sort((a, b) => a.receipt.received_at.localeCompare(b.receipt.received_at));
    for (const item of receipts.slice(0, 100)) {
      if (signal.aborted) return;
      let accepted = false;
      try { await this.applyReceipt(item.receipt, signal); accepted = true; }
      catch (error) {
        this.status.last_error = error.code ?? 'DECISION_FAILED';
        // Conflicts are terminal decisions to refresh, not retries that can gain
        // authority. Lost CLI responses remain pending and replay the SAME ID.
        if (error.code === 'RECEIPT_UNAUTHORIZED' || error.code === 'TARGET_MISMATCH' || (error.code === 'OPERATION_REJECTED' && error.message.includes('decision version mismatch'))) {
          item.receipt.rejected = true; item.receipt.reason = error.code; accepted = true;
          await atomicJSON(join(root, 'pending', item.filename), item.receipt);
        }
      }
      if (accepted) {
        await rename(join(root, 'pending', item.filename), join(root, 'accepted', item.filename));
        // A directory durability barrier also covers the atomic receipt move.
        await atomicJSON(join(root, 'accepted', 'checkpoint.json'), { updated_at: new Date().toISOString() });
      }
    }
  }
  async notifyResults(signal) {
    const jobs = await this.automation({ action: 'notifications' }, signal);
    for (const job of jobs) {
      const key = 'card:' + hash(job.identity);
      const binding = this.ledger.cards[key];
      try {
        const posted = await this.postOnce('result:' + job.job_id, { ...buildJobResult(job), ...(binding && !binding.deleted ? { thread_ts: binding.thread_ts } : {}) }, signal);
        if (!posted) continue;
        // A deleted or stale card cannot undo a confirmed result delivery or
        // prevent later verification jobs from running.
        await this.automation({ action: 'notified', job_id: job.job_id }, signal);
        await this.optionalCardRefresh(key, job.reference, signal, job.result.slice(0, 1000));
      } catch (error) { this.status.last_error = error.code ?? 'NOTIFICATION_FAILED'; }
    }
  }
  async runOneJob(signal) {
    if (this.jobActive) throw new AutomationError('WORKER_BUSY');
    this.jobActive = true;
    try {
      // Only entered after the preceding execution/disposal has settled. A lost CLI
      // claim/finish response must not leave a permanent running row or replay work.
      const orphaned = await this.automation({ action: 'list', status: 'running' }, signal);
      if (orphaned.length) await this.automation({ action: 'recover' }, signal);
      const jobs = await this.automation({ action: 'list', status: 'queued' }, signal);
      const candidate = jobs[0];
      if (!candidate) return;
      if (await realpath(candidate.target) !== await realpath(this.config.targetRoot)) throw new AutomationError('TARGET_MISMATCH');
      const job = await this.automation({ action: 'claim', job_id: candidate.job_id, session_id: randomUUID() }, signal);
      if (!job) return;
      this.status.last_job = { job_id: job.job_id, status: 'running', session_id: job.session_id }; await this.saveStatus();
      let result;
      try {
        const input = await this.automation({ action: 'verification-input', job_id: job.job_id }, signal);
        if (input.job_id !== job.job_id || input.input_hash !== job.input_hash) throw new AutomationError('VERIFICATION_INPUT_MISMATCH');
        result = await this.execute(this.ctx, this.config, job, signal, { material: input.material });
      }
      catch (error) { result = { status: 'unknown', result: `実行結果を確定できませんでした（${error.code ?? 'EXECUTION_FAILED'}）。自動再実行せずSessionを確認します。`, verified: false, artifacts: [] }; }
      const saved = await this.automation({ action: 'finish', job_id: job.job_id, session_id: job.session_id, ...result }, AbortSignal.timeout(15000));
      this.status.last_job = { job_id: saved.job_id, status: saved.status, session_id: saved.session_id }; await this.saveStatus();
    } finally { this.jobActive = false; }
  }
  async run(signal) {
    await mkdir(this.config.bridgeStateRoot, { recursive: true, mode: 0o700 });
    this.ledger = await readJSON(join(this.config.bridgeStateRoot, 'delivery.json'), { version: 1, team_id: this.config.teamId, channel_id: this.config.channelId, cards: {}, deliveries: {} });
    if (this.ledger.version !== 1 || this.ledger.team_id !== this.config.teamId || this.ledger.channel_id !== this.config.channelId) throw new AutomationError('DELIVERY_STORE_MISMATCH');
    const lock = await acquireWorkerLock(this.config, signal);
    const owned = new AbortController();
    const stop = () => owned.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    let socketTask;
    try {
      void lock.lost.catch(() => owned.abort('worker lock lost'));
      const llm = this.ctx.get('llm');
      if (!llm?.listProviders().some(provider => provider.id === this.config.route.provider)) throw new AutomationError('MODEL_PROVIDER_UNAVAILABLE');
      await llm.resolveCallConfig(this.config.route, owned.signal);
      const checkId = randomUUID();
      this.status.mount_check = await this.execute(this.ctx, this.config, { job_id: 'mount-check-' + checkId, session_id: checkId, target: this.config.targetRoot, workflow: 'development-verification' }, owned.signal, { mountOnly: true });
      await this.automation({ action: 'recover' }, owned.signal);
      while (!owned.signal.aborted) {
        try {
          const missing = await this.readiness(owned.signal);
          this.status.missing = missing;
          this.status.phase = missing.length ? 'needs_configuration' : 'online';
          await this.saveStatus();
          if (!missing.length) {
            if (!socketTask) {
              const socket = this.socketFactory({ client: this.client, beforeAck: payload => this.acceptInteraction(payload), onInteraction: () => {
                const task = this.interactions.then(() => this.enqueue(() => this.drainInbox(owned.signal)));
                this.interactions = task.catch(async error => { this.status.last_error = error.code ?? 'INTERACTION_REJECTED'; await this.saveStatus(); });
                return this.interactions;
              }, onStatus: state => { this.status.socket = state; void this.saveStatus().catch(() => {}); } });
              socketTask = socket.start(owned.signal).catch(error => { this.status.last_error = error.code ?? 'SOCKET_FAILED'; }).finally(() => { socketTask = undefined; });
            }
            this.postBudget = 26;
            await this.enqueue(async () => {
              await this.drainInbox(owned.signal);
              await this.automation({ action: 'sync' }, owned.signal);
              await this.notifyResults(owned.signal);
              try { await this.publishIntakeAttention(owned.signal); await this.publishDigest(owned.signal); } catch (error) { this.status.last_error = error.code ?? 'DIGEST_DELIVERY_FAILED'; }
            });
            // Execution does not hold the UI serial chain: a new human decision can arrive while a job runs.
            await this.runOneJob(owned.signal);
            await this.enqueue(() => this.notifyResults(owned.signal));
          }
        } catch (error) { if (!owned.signal.aborted) { this.status.phase = 'needs_attention'; this.status.last_error = error.code ?? 'BRIDGE_FAILED'; await this.saveStatus(); } }
        await delay(this.config.pollSeconds * 1000, undefined, { signal: owned.signal }).catch(() => {});
      }
    } finally {
      owned.abort(); await socketTask; await this.interactions; await this.serial; await this.managementSerial;
      this.status.phase = 'stopped'; await this.saveStatus();
      signal.removeEventListener('abort', stop); await lock.release();
    }
  }
}
export function apply(ctx, raw) {
  const config = resolveBridgeConfig(raw);
  ctx.effect(() => {
    const controller = new AbortController();
    const bridge = new SlackIntakeBridge(ctx, config);
    const task = bridge.run(controller.signal).catch(async error => {
      bridge.status.phase = 'failed'; bridge.status.last_error = error.code ?? 'BRIDGE_START_FAILED'; await bridge.saveStatus();
      if (config.exitOnFailure === true) ctx.get('appExit')?.(1);
    });
    return async () => { controller.abort(); await task; };
  });
}
