import { createHash } from 'node:crypto';

export const POLICIES = Object.freeze([
  { value: 'undecided', label: '未判断' },
  { value: 'reading', label: '読み物' },
  { value: 'verify-now', label: '即検証' },
  { value: 'not-applicable', label: '導入対象外' },
  { value: 'deferred', label: '導入保留' },
  { value: 'obsolete', label: '陳腐化' },
  { value: 'verified', label: '検証済み' },
].map(Object.freeze));
const POLICY = new Map(POLICIES.map(p => [p.value, p.label]));
const ACTION_ID = 'slack_intake_policy';
const NOTICE = '即検証では、まず資料の主張と用途を確認します。対象未指定の実験や変更は行いません。';
const JOB_STATUS = Object.freeze({
  queued: '受付済み', running: '検証中', succeeded: '処理完了', failed: '失敗',
  unknown: '状態不明（要確認）', cancelled: '中止',
});
const plain = text => ({ type: 'plain_text', text: text || '（なし）', emoji: false });
const section = text => ({ type: 'section', text: plain(text) });
const context = text => ({ type: 'context', elements: [plain(text)] });
const clip = (value, limit) => {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text;
};
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Top-level fallback is mrkdwn in Slack: also disable automatic URL/mention interpretation.
const fallback = text => escape(text).replace(/([a-z][a-z0-9+.-]*):\/\//gi, '$1:\u200b//')
  .replace(/\.([a-z])/gi, '.\u200b$1').replace(/@/g, '@\u200b');
const error = code => Object.assign(new Error(code), { code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
const validVersion = value => Number.isSafeInteger(value) && value >= 0;

function policyBlock(identity, version) {
  if (!validIdentity(identity) || !validVersion(version)) throw error('invalid-card');
  const id = 'policy:' + Buffer.from(JSON.stringify({ identity, version }), 'utf8').toString('base64url');
  // Slack block_id has a 255-character maximum. Never truncate reference identity/version.
  if (id.length > 255) throw error('invalid-card');
  return id;
}

function sourceLink(value) {
  if (typeof value !== 'string' || value.length > 1000 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        /^https?:\/\/[^/]*@/i.test(value)) return null;
    const safe = escape(url.href.replace(/[|<>]/g, c => encodeURIComponent(c)));
    return safe.length <= 2400 ? `<${safe}|元資料を開く>` : null;
  } catch { return null; }
}

/** All source prose and verification output use plain_text, never executable mrkdwn.
 * Only the separately validated source URL becomes a link. Titles are deterministic.
 */
export function buildReferenceCard(reference, decision, { targetLabel = '開発環境', resultText = '', statusText = '' } = {}) {
  if (!record(reference) || !record(decision) || !POLICY.has(decision.usage_policy)) throw error('invalid-card');
  const blockId = policyBlock(reference.identity, decision.decision_version);
  const summary = clip(reference.summary, 800) || '要約なし';
  const title = clip(summary.split(/\r?\n/)[0], 120) || '参照資料';
  const category = clip(reference.category, 160) || '未分類';
  const policy = POLICY.get(decision.usage_policy);
  const options = POLICIES.map(p => ({ text: plain(p.label), value: p.value }));
  const link = sourceLink(reference.url);
  const blocks = [
    { type: 'header', text: plain(title) },
    section(summary),
    context(`分類：${category} ／ 方針：${policy}`),
    link ? { type: 'section', text: { type: 'mrkdwn', text: link, verbatim: true } } : section('元資料URL：無効または未設定'),
    { type: 'actions', block_id: blockId, elements: [{
      type: 'static_select', action_id: ACTION_ID, placeholder: plain('活用方針を選択'),
      options, initial_option: options.find(p => p.value === decision.usage_policy),
    }] },
    context(`確認範囲：${clip(targetLabel, 120) || '用途の確認'}\n${NOTICE}`),
  ];
  if (reference.content_hash) blocks.push(context(`内容ハッシュ：${clip(reference.content_hash, 80) || '不明'}`));
  if (statusText) blocks.push(section(`状態：${clip(statusText, 300)}`));
  if (resultText) blocks.push(section(`確認結果：\n${clip(resultText, 1000)}`));
  // Accessible fallback deliberately has no automatically executable URL or source mentions.
  const text = fallback(`${title}\n${summary}\n分類：${category} ／ 方針：${policy}\n${NOTICE}` +
    (statusText ? `\n状態：${clip(statusText, 300)}` : '') + (resultText ? `\n確認結果：${clip(resultText, 1000)}` : ''));
  return { text, blocks };
}

export function buildDigestHeader({ date, newCount, heldCount, status } = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '不明';
  const title = `参照資料の日次まとめ ${clip(date, 32) || '日付不明'}`;
  const body = `新規：${count(newCount)}件 ／ 保留：${count(heldCount)}件\n状態：${clip(status, 160) || '不明'}`;
  return { text: fallback(`${title}\n${body}`), blocks: [{ type: 'header', text: plain(title) }, section(body)] };
}

/** job: {status, verified, evidence_summary (or evidence.summary / result.summary / result), session_id}.
 * A completed process is not evidence of completed verification.
 */
export function buildJobResult(job = {}) {
  const status = Object.hasOwn(JOB_STATUS, job.status) ? job.status : 'unknown';
  const evidence = clip(job.evidence_summary ?? job.evidence?.summary ?? job.result?.summary ?? job.result, 1000) || '結果の要約なし';
  const unverifiedLabel = evidence.startsWith('検証対象の指定が必要です') ? '用途の確認が必要' : evidence.startsWith('根拠不足') ? '根拠不足' : '確認結果（実機未検証）';
  const label = status === 'succeeded' ? (job.verified === true ? '検証済み' : unverifiedLabel) : JOB_STATUS[status];
  const title = `資料チェック：${label}`;
  const session = clip(job.session_id, 160) || '未設定';
  const body = `結果：${evidence}`;
  return { text: fallback(`${title}\n${body}\n実行記録：${session}`), blocks: [{ type: 'header', text: plain(title) }, section(body), context(`実行記録：${session}`)] };
}

function decodeBlock(blockId) {
  if (typeof blockId !== 'string' || blockId.length > 255 || !/^policy:[A-Za-z0-9_-]+$/.test(blockId)) throw error('invalid-action');
  const encoded = blockId.slice(7);
  let data;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw error('invalid-action'); }
  if (!record(data) || Object.keys(data).sort().join(',') !== 'identity,version' ||
      !validIdentity(data.identity) || !validVersion(data.version) || policyBlock(data.identity, data.version) !== blockId) {
    throw error('invalid-action');
  }
  return data;
}

/** Only call with an authenticated Socket Mode payload (not arbitrary HTTP input).
 * botUserId must come from authenticated auth.test; an app_id alone cannot prove ownership.
 * Optimistic concurrency, durable acceptance and replay deduplication belong to the bridge.
 */
export function parsePolicyAction(payload, { teamId, channelId, allowedUsers, botUserId } = {}) {
  if (!record(payload) || payload.type !== 'block_actions') throw error('invalid-action');
  const team = payload.team?.id;
  const user = payload.user?.id;
  const channel = payload.channel?.id;
  const slackId = (value, prefix) => typeof value === 'string' && new RegExp(`^[${prefix}][A-Z0-9]{1,31}$`).test(value);
  const permitted = Array.isArray(allowedUsers) ? allowedUsers.includes(user) : allowedUsers instanceof Set && allowedUsers.has(user);
  if (!slackId(teamId, 'T') || !slackId(channelId, 'CG') || !slackId(botUserId, 'UW') ||
      team !== teamId || channel !== channelId || !slackId(user, 'UW') || !permitted || user === botUserId ||
      payload.user?.is_bot || payload.user?.is_app_user || payload.user?.bot_id || payload.user?.bot_profile || user === 'USLACKBOT' ||
      (payload.user?.team_id && payload.user.team_id !== teamId) || payload.message?.user !== botUserId) {
    throw error('unauthorized');
  }
  const messageTs = payload.message?.ts;
  const timestamp = value => typeof value === 'string' && /^\d{1,20}\.\d{1,9}$/.test(value);
  if (!timestamp(messageTs) || !Array.isArray(payload.actions) || payload.actions.length !== 1 ||
      (payload.container?.channel_id && payload.container.channel_id !== channel) ||
      (payload.container?.message_ts && payload.container.message_ts !== messageTs) ||
      (payload.container?.type && payload.container.type !== 'message')) throw error('invalid-action');
  const action = payload.actions[0];
  if (!record(action) || action.action_id !== ACTION_ID || action.type !== 'static_select' ||
      !timestamp(action.action_ts) || !POLICY.has(action.selected_option?.value)) throw error('invalid-action');
  const { identity, version } = decodeBlock(action.block_id);
  const policy = action.selected_option.value;
  const requestId = createHash('sha256').update(JSON.stringify([
    team, user, channel, messageTs, action.action_ts, action.action_id, policy, action.block_id,
  ])).digest('hex');
  return { identity, version, policy, requestId, actor: `slack:${team}:${user}`, messageTs };
}
