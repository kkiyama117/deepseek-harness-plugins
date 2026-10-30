import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackIntakeBridge } from '../bridge.mjs';
import { SlackApiError } from '../slack-client.mjs';
import { buildReferenceCard } from '../slack-cards.mjs';
import { AutomationError } from '../automation-client.mjs';

async function setup(t, management, client, execute) {
  const directory = await mkdtemp(join(tmpdir(), 'slack-bridge-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { aistoreExecutable: '/trusted/aistore', storeRoot: join(directory, 'references'), stateHome: join(directory, 'management'), bridgeStateRoot: join(directory, 'bridge'), targetRoot: directory, artifactsRoot: join(directory, 'artifacts'), teamId: 'TTEST', channelId: 'CTEST', allowedUsers: ['UTEST'], presetId: 'fixture', route: { provider: 'fixture', model: 'fixed', reasoningEffort: 'high', maxTokens: 100 }, pollSeconds: 60, jobTimeoutSeconds: 10, maxModelSteps: 2 };
  const bridge = new SlackIntakeBridge({}, config, { management, client: client ?? { async call() { return { ok: true, ts: '1812249600.000001' }; } }, execute });
  bridge.ledger = { version: 1, cards: {}, deliveries: {} }; bridge.botUserId = 'UBOT';
  return { bridge, config, directory };
}
const signal = () => new AbortController().signal;
const ref = { identity: 'url:https://example.test', url: 'https://example.test', category: 'programming', summary: '合成資料', content_hash: 'a'.repeat(64) };
function payload() {
  const card = buildReferenceCard({ ...ref, identity: 'card:test' }, { usage_policy: 'undecided', decision_version: 0 });
  return { type: 'block_actions', team: { id: 'TTEST' }, channel: { id: 'CTEST' }, user: { id: 'UTEST' }, message: { user: 'UBOT', ts: '1812249600.000001', text: 'PRIVATE_RAW_SLACK_MUST_NOT_BE_STORED' }, actions: [{ action_id: 'slack_intake_policy', type: 'static_select', block_id: card.blocks.find(b => b.type === 'actions').block_id, action_ts: '1812249601.000001', selected_option: { value: 'reading' } }] };
}

test('durable normalized inbox survives receiver restart and replays once without raw Slack body', async t => {
  let submits = 0;
  const management = async (_c, r) => {
    if (r.action === 'decision-submit') { submits++; return { identity: ref.identity, usage_policy: 'reading', decision_version: 1, job_id: '' }; }
    if (r.action === 'snapshot') return { references: [ref] };
    if (r.action === 'policy-get') return { identity: ref.identity, usage_policy: 'reading', decision_version: 1 };
    if (r.action === 'sync') return {};
    throw new Error(r.action);
  };
  const { bridge, config } = await setup(t, management);
  bridge.ledger.cards['card:test'] = { identity: ref.identity, ts: '1812249600.000001' };
  assert.equal(await bridge.acceptInteraction(payload()), true);
  assert.equal(submits, 0);
  const receipt = bridge.decisionReceipt(payload());
  const pending = join(config.bridgeStateRoot, 'inbox/pending', receipt.request.request_id + '.json');
  const text = await readFile(pending, 'utf8');
  assert.ok(!text.includes('PRIVATE_RAW_SLACK')); assert.ok(text.includes('decision-submit'));
  const restarted = new SlackIntakeBridge({}, config, { management, client: bridge.client });
  restarted.ledger = bridge.ledger;
  await restarted.drainInbox(signal());
  assert.equal(submits, 1);
  assert.ok(await readFile(join(config.bridgeStateRoot, 'inbox/accepted', receipt.request.request_id + '.json'), 'utf8'));
  assert.equal(await restarted.acceptInteraction({ ...payload(), user: { id: 'UNAUTHORIZED' } }), false);
  restarted.botUserId = 'UBOT';
  assert.equal(await restarted.acceptInteraction(payload()), true);
  await restarted.drainInbox(signal()); assert.equal(submits, 1);
});

test('confirmed result delivery is saved even if its card was deleted', async t => {
  let notified = false; let posts = 0;
  const job = { job_id: 'job:one', identity: ref.identity, reference: ref, status: 'succeeded', verified: true, result: '合成結果', session_id: 'session:one', notified: false };
  const management = async (_c, r) => {
    if (r.action === 'notifications') return notified ? [] : [job];
    if (r.action === 'notified') { notified = true; return { ...job, notified: true }; }
    if (r.action === 'policy-get') return { usage_policy: 'verified', decision_version: 2 };
    throw new Error(r.action);
  };
  const client = { async call(method) { if (method === 'chat.postMessage') { posts++; return { ts: '1812249600.000002' }; } throw new SlackApiError('message_not_found', 'definite'); } };
  const { bridge } = await setup(t, management, client);
  const { createHash } = await import('node:crypto');
  const key = 'card:' + createHash('sha256').update(ref.identity).digest('hex');
  bridge.ledger.cards[key] = { identity: ref.identity, ts: '1812249600.000001', thread_ts: '1812249599.000001' };
  await bridge.notifyResults(signal()); await bridge.notifyResults(signal());
  assert.equal(notified, true); assert.equal(posts, 1); assert.equal(bridge.ledger.cards[key].deleted, true);
});

for (const failure of ['claim', 'finish']) test(`lost ${failure} response becomes unknown on settled worker boundary without replay`, async t => {
  let status = 'queued'; let executions = 0; let savedSession = '';
  const job = { job_id: 'job:test', identity: ref.identity, workflow: 'development-verification' };
  const management = async (config, r) => {
    if (r.action === 'list') return status === r.status ? [{ ...job, target: config.targetRoot, session_id: savedSession, status }] : [];
    if (r.action === 'recover') { status = 'unknown'; return { recovered: 1 }; }
    if (r.action === 'claim') { status = 'running'; savedSession = r.session_id; if (failure === 'claim') throw new AutomationError('PROCESS_FAILED'); return { ...job, target: config.targetRoot, session_id: savedSession, status }; }
    if (r.action === 'verification-input') return { job_id: job.job_id, input_hash: undefined, material: { status: 'available', text: '合成記事' } };
    if (r.action === 'finish') throw new AutomationError('PROCESS_FAILED');
    throw new Error(r.action);
  };
  const { bridge } = await setup(t, management, undefined, async () => { executions++; return { status: 'succeeded', result: '合成結果', verified: false, artifacts: [] }; });
  await assert.rejects(bridge.runOneJob(signal()));
  assert.equal(status, 'running');
  await bridge.runOneJob(signal());
  assert.equal(status, 'unknown'); assert.equal(executions, failure === 'claim' ? 0 : 1);
});

test('digest delivery advances a completion cursor independent of GUI history limits', async t => {
  const requests = [];
  const batch = { batch_id: 'old-batch-late-completion', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-06T02:00:00Z', status: 'completed' };
  const management = async (_c, r) => {
    requests.push(r);
    if (r.action === 'digest-batches') return { batches: r.latest ? [batch] : [], has_more: false };
    if (r.action === 'digest') return { batch, references: [], counts: { newly_registered: 0, held: 0, pending: 0 } };
    throw new Error(r.action);
  };
  const { bridge } = await setup(t, management);
  await bridge.publishDigest(signal()); await bridge.publishDigest(signal());
  assert.deepEqual(requests[0], { action: 'digest-batches', latest: true });
  assert.deepEqual(requests.at(-1), { action: 'digest-batches', after_updated_at: batch.updated_at, after_batch_id: batch.batch_id });
  assert.equal(Object.keys(bridge.ledger.deliveries).length, 1);
});
