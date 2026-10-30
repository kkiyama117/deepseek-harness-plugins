import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { POLICIES, buildReferenceCard, buildDigestHeader, buildJobResult, parsePolicyAction } from '../slack-cards.mjs';

const reference = { identity: 'card:fixture', url: 'https://example.org/source?a=1&b=2',
  summary: '資料の要約\n二行目', category: 'algorithms-complexity', content_hash: 'sha256:fixture' };
const decision = { usage_policy: 'undecided', decision_version: 3 };
const config = { teamId: 'TTEST', channelId: 'CTEST', allowedUsers: ['UHUMAN'], botUserId: 'UBOT' };
const blockId = buildReferenceCard(reference, decision).blocks.find(b => b.type === 'actions').block_id;
const fixture = () => ({ type: 'block_actions', team: { id: 'TTEST' }, user: { id: 'UHUMAN', team_id: 'TTEST' },
  channel: { id: 'CTEST' }, message: { user: 'UBOT', ts: '1234567890.000001' },
  container: { type: 'message', channel_id: 'CTEST', message_ts: '1234567890.000001' },
  actions: [{ type: 'static_select', action_id: 'slack_intake_policy', block_id: blockId,
    action_ts: '1234567891.000002', selected_option: { value: 'verify-now' } }] });
const rejects = (payload, code = 'invalid-action', options = config) => {
  assert.throws(() => parsePolicyAction(payload, options), error => {
    assert.equal(error.message, code); assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error), /secret/); return true;
  });
};

function bounded(card) {
  assert.equal(typeof card.text, 'string');
  assert.ok(card.text.length < 16000);
  assert.ok(card.blocks.length <= 10);
  for (const block of card.blocks) {
    if (block.text) assert.ok(block.text.text.length <= (block.type === 'header' ? 150 : 3000));
    for (const item of block.elements ?? []) if (item.type === 'plain_text') assert.ok(item.text.length <= 2000);
    if (block.block_id) assert.ok(block.block_id.length <= 255);
  }
}

test('policy list contains exactly seven Japanese options and cannot be mutated', () => {
  assert.deepEqual(POLICIES.map(p => p.value), ['undecided', 'reading', 'verify-now', 'not-applicable', 'deferred', 'obsolete', 'verified']);
  assert.deepEqual(POLICIES.map(p => p.label), ['未判断', '読み物', '即検証', '導入対象外', '導入保留', '陳腐化', '検証済み']);
  assert.throws(() => { POLICIES[0].label = 'changed'; }, TypeError);
});

for (const policy of POLICIES) {
  test(`reference card selects ${policy.value} and encodes exact identity/version`, () => {
    const card = buildReferenceCard(reference, { ...decision, usage_policy: policy.value });
    bounded(card);
    const block = card.blocks.find(b => b.type === 'actions');
    const select = block.elements[0];
    assert.equal(select.type, 'static_select');
    assert.equal(select.action_id, 'slack_intake_policy');
    assert.equal(select.placeholder.text, '活用方針を選択');
    assert.equal(select.options.length, 7);
    assert.equal(select.initial_option.value, policy.value);
    assert.equal(select.initial_option.text.text, policy.label);
    assert.deepEqual(select.initial_option, select.options.find(p => p.value === policy.value));
    assert.equal(block.block_id, 'policy:' + Buffer.from(JSON.stringify({ identity: reference.identity, version: 3 })).toString('base64url'));
    assert.match(card.text, /即検証では、まず資料の主張と用途を確認します。対象未指定の実験や変更は行いません。/);
    assert.match(card.text, /algorithms-complexity/);
    assert.ok(card.blocks.some(b => b.text?.text === '<https://example.org/source?a=1&amp;b=2|元資料を開く>'));
  });
}

test('untrusted summary/title/category/verification remain plain text, fallback escapes mentions/links', () => {
  const hostile = '<!channel> & <@UHUMAN> @channel https://evil.invalid/run <https://evil|run>';
  const card = buildReferenceCard({ ...reference, summary: hostile, category: hostile, content_hash: hostile }, decision,
    { resultText: hostile, statusText: hostile, targetLabel: hostile });
  const proseBlocks = card.blocks.filter(b => b.type !== 'actions' && b.text?.type !== 'mrkdwn');
  assert.ok(proseBlocks.some(b => b.text?.type === 'plain_text' && b.text.text === hostile));
  assert.ok(card.blocks.some(b => b.text?.type === 'plain_text' && b.text.text.includes('確認結果：\n' + hostile)));
  assert.doesNotMatch(card.text, /<!channel>|<@|<https|@channel|https:\/\//);
  assert.match(card.text, /&lt;!channel&gt; &amp;/);
  assert.equal(card.blocks.filter(b => b.text?.type === 'mrkdwn').length, 1);
});

test('cards bound oversized text, retain valid Unicode and derive title deterministically', () => {
  const long = '😀'.repeat(5000) + '<!channel>';
  const card = buildReferenceCard({ ...reference, summary: long, category: long, content_hash: long }, decision,
    { resultText: long, statusText: long, targetLabel: long });
  bounded(card);
  assert.ok(card.blocks[1].text.text.length <= 800);
  assert.ok(card.blocks[0].text.text.length <= 120);
  assert.doesNotMatch(card.blocks[1].text.text, /[\uD800-\uDBFF]…/);
  assert.deepEqual(card, buildReferenceCard({ ...reference, summary: long, category: long, content_hash: long }, decision,
    { resultText: long, statusText: long, targetLabel: long }));
});

for (const url of ['javascript:alert(1)', 'data:text/html,secret', 'https://secret@example.org/path',
  'https://user:secret@example.org/path', 'https://@example.org/path', 'https://example.org/\nsecret',
  'not-a-url', 'https://example.org/' + 'a'.repeat(1100)]) {
  test('invalid/credential source URL never becomes a link', () => {
    const card = buildReferenceCard({ ...reference, url }, decision);
    assert.equal(card.blocks.some(b => b.text?.type === 'mrkdwn'), false);
    assert.match(JSON.stringify(card.blocks), /元資料URL：無効または未設定/);
    assert.doesNotMatch(card.text, /secret/);
  });
}

test('validated http URL cannot inject Slack label syntax', () => {
  const card = buildReferenceCard({ ...reference, url: 'http://example.org/a|<!channel>?a=1&b=2' }, decision);
  const link = card.blocks.find(b => b.text?.type === 'mrkdwn').text;
  assert.equal(link.verbatim, true);
  assert.match(link.text, /%7C%3C!channel%3E/);
  assert.doesNotMatch(link.text, /<!channel>/);
  assert.equal((link.text.match(/\|/g) ?? []).length, 1);
});

for (const [ref, dec] of [
  [null, decision], [reference, null], [reference, { ...decision, usage_policy: 'secret' }],
  [{ ...reference, identity: '' }, decision], [{ ...reference, identity: 'x'.repeat(200) }, decision],
  [{ ...reference, identity: 'a\nsecret' }, decision], [reference, { ...decision, decision_version: -1 }],
  [reference, { ...decision, decision_version: Number.MAX_SAFE_INTEGER + 1 }],
]) {
  test('invalid card identity/decision fails statically rather than truncating identifiers', () => {
    assert.throws(() => buildReferenceCard(ref, dec), error => error.code === 'invalid-card' && error.message === 'invalid-card');
  });
}

test('digest header is bounded Japanese output and unknown counts remain unknown', () => {
  const header = buildDigestHeader({ date: '2026-10-06', newCount: 4, heldCount: 2, status: '完了' });
  bounded(header);
  assert.match(header.text, /2026-10-06/);
  assert.match(header.text, /新規：4件 ／ 保留：2件/);
  assert.match(buildDigestHeader({ newCount: -1, heldCount: 'secret' }).text, /新規：不明件 ／ 保留：不明件/);
  const hostile = buildDigestHeader({ date: '<!channel>', status: 'https://evil @here & <run>'.repeat(1000) });
  bounded(hostile);
  assert.doesNotMatch(hostile.text, /<!channel>|https:\/\/|@here/);
});

for (const [status, expected] of [['queued', '受付済み'], ['running', '検証中'], ['succeeded', '確認結果（実機未検証）'],
  ['failed', '失敗'], ['unknown', '状態不明（要確認）'], ['cancelled', '中止'], ['secret', '状態不明（要確認）']]) {
  test(`job status ${status} does not confuse completion with verification`, () => {
    const card = buildJobResult({ status, evidence_summary: '証拠の要約', session_id: 'session:fixture' });
    bounded(card);
    assert.match(card.text, new RegExp(expected.replace(/[（）]/g, '\\$&')));
    assert.match(card.text, /session:fixture/);
    if (status !== 'succeeded') assert.doesNotMatch(card.text, /検証済み/);
  });
}

test('only succeeded with verified===true is verified; evidence and sessions cannot execute links', () => {
  assert.match(buildJobResult({ status: 'succeeded', verified: true }).text, /検証済み/);
  for (const verified of [false, undefined, 'true', 1]) {
    assert.match(buildJobResult({ status: 'succeeded', verified }).text, /確認結果（実機未検証）/);
  }
  assert.doesNotMatch(buildJobResult({ status: 'unknown', verified: true }).text, /検証済み/);
  const hostile = '<!channel> & <https://evil|run> https://evil @everyone www.evil.com human@evil.com';
  const card = buildJobResult({ status: 'succeeded', verified: false, evidence_summary: hostile, session_id: hostile });
  assert.doesNotMatch(card.text, /<!|<https|https:\/\/|@everyone|www\.evil\.com|human@evil\.com/);
  assert.equal(card.blocks[1].text.type, 'plain_text');
  assert.ok(card.blocks[1].text.text.includes(hostile));
  bounded(buildJobResult({ status: 'running', evidence_summary: 'a'.repeat(5000), session_id: 'b'.repeat(5000) }));
  for (const extra of [{ evidence: { summary: '証拠' } }, { result: '証拠' }, { result: { summary: '証拠' } }]) {
    assert.match(buildJobResult(extra).text, /結果：証拠/);
  }
});

test('authorized human action returns stable digest independent of envelope delivery', () => {
  const payload = fixture();
  const result = parsePolicyAction(payload, config);
  assert.deepEqual(result, { identity: reference.identity, version: 3, policy: 'verify-now',
    requestId: createHash('sha256').update(JSON.stringify(['TTEST', 'UHUMAN', 'CTEST', '1234567890.000001',
      '1234567891.000002', 'slack_intake_policy', 'verify-now', blockId])).digest('hex'),
    actor: 'slack:TTEST:UHUMAN', messageTs: '1234567890.000001' });
  assert.deepEqual(result, parsePolicyAction({ ...payload, envelope_id: 'different' }, config));
  assert.deepEqual(result, parsePolicyAction(payload, { ...config, allowedUsers: new Set(['UHUMAN']) }));
  payload.actions[0].action_ts = '1234567891.000003';
  assert.notEqual(result.requestId, parsePolicyAction(payload, config).requestId);
});

for (const mutate of [
  p => { p.team.id = 'TOTHER'; }, p => { p.channel.id = 'COTHER'; },
  p => { p.user.id = 'UOTHER'; }, p => { p.user.id = 'UBOT'; },
  p => { p.user.is_bot = true; }, p => { p.user.bot_id = 'BSECRET'; },
  p => { p.user.is_app_user = true; }, p => { p.user.bot_profile = { id: 'BSECRET' }; },
  p => { p.user.team_id = 'TOTHER'; }, p => { p.message.user = 'UOTHER'; },
  p => { delete p.message; }, p => { delete p.team; },
]) {
  test('authorization rejects other teams/channels/users/bots and foreign message owners', () => {
    const p = fixture(); mutate(p); rejects(p, 'unauthorized');
  });
}

test('missing/invalid authorization configuration fails closed', () => {
  for (const options of [{}, { ...config, allowedUsers: [] }, { ...config, allowedUsers: '*' },
    { ...config, botUserId: '' }, { ...config, botUserId: 'BSECRET' }]) rejects(fixture(), 'unauthorized', options);
  const p = fixture(); p.user.id = 'USLACKBOT';
  rejects(p, 'unauthorized', { ...config, allowedUsers: ['USLACKBOT'] });
});

for (const mutate of [
  p => { p.type = 'view_submission'; }, p => { p.actions = []; },
  p => { p.actions.push({ ...p.actions[0] }); }, p => { p.actions[0].action_id = 'secret'; },
  p => { p.actions[0].type = 'button'; }, p => { p.actions[0].selected_option.value = 'secret'; },
  p => { p.actions[0].selected_option = null; }, p => { p.actions[0].action_ts = 'secret'; },
  p => { p.message.ts = 'secret'; }, p => { p.container.message_ts = '1234567890.000002'; },
  p => { p.container.channel_id = 'COTHER'; }, p => { p.container.type = 'view'; },
]) {
  test('malformed, duplicate, mismatched container, wrong action or policy fails statically', () => {
    const p = fixture(); mutate(p); rejects(p);
  });
}

for (const data of [{ identity: 'card:fixture', version: -1 }, { identity: '', version: 0 },
  { identity: 'card:fixture', version: 1.5 }, { identity: 'card:fixture', version: '3' },
  { identity: 'card:fixture', version: Number.MAX_SAFE_INTEGER + 1 }, { identity: 'card:fixture', version: 3, extra: 'secret' },
  { version: 3, identity: 'card:fixture' }, ['secret'], null]) {
  test('block metadata requires canonical strict identity/version encoding', () => {
    const p = fixture(); p.actions[0].block_id = 'policy:' + Buffer.from(JSON.stringify(data)).toString('base64url');
    rejects(p);
  });
}

test('non-base64url, padded, invalid UTF-8, oversized and malformed block IDs are rejected', () => {
  for (const id of ['secret', blockId + '=', 'policy:@@', 'policy:' + Buffer.from('{').toString('base64url'),
    'policy:' + Buffer.from([255]).toString('base64url'), 'policy:' + 'a'.repeat(260)]) {
    const p = fixture(); p.actions[0].block_id = id; rejects(p);
  }
  rejects(null);
});
