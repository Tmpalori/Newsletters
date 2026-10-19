/* server/slack.js — Owner notifications in Slack via an incoming webhook.
 *
 * Same setup as austincommercialsites.com: SLACK_WEBHOOK_URL holds a Slack
 * incoming-webhook URL (Railway variable, production only). Unset means
 * every call is a no-op, so local runs, tests and PR environments stay quiet.
 *
 * Channels: each message goes to one of three, each with its own webhook.
 * Any channel left unset falls back to SLACK_WEBHOOK_URL.
 *   sales     SLACK_SALES_WEBHOOK_URL     sponsor orders, refunds, disputes
 *   activity  SLACK_ACTIVITY_WEBHOOK_URL  submission review, subscribers, publishing
 *   alerts    SLACK_ALERTS_WEBHOOK_URL    anything broken (every alert())
 *   hype      SLACK_HYPE_WEBHOOK_URL      wins only: new sponsors, Vic's Picks, and HQ's ping for every 10 new subscribers across all towns
 *   inbox     SLACK_INBOX_WEBHOOK_URL     people talking to us: email replies, contact form, event submissions, our replies
 * hype falls back to sales and inbox to activity (then SLACK_WEBHOOK_URL),
 * so nothing moves until those channels have their own webhook.
 *
 * Sends are fire-and-forget: a Slack outage must never break a submission,
 * a checkout or a page view. Alerts (things breaking) are de-duplicated by
 * key so a crash loop or a bad deploy pings once per window, not per request.
 */

const ALERT_WINDOW_MS = 15 * 60 * 1000;

// Slack mrkdwn treats &, <, > specially; escape anything user-supplied so it
// can't inject links or @channel mentions.
export const slackEscape = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const SLACK_CHANNELS = ['sales', 'activity', 'alerts', 'hype', 'inbox'];
const FALLBACK = { hype: 'sales', inbox: 'activity' };
// Alerts never vanish because only some channels are set up: with neither
// their own webhook nor SLACK_WEBHOOK_URL they go to activity.
const LAST_RESORT = { alerts: 'activity' };
const isHook = (u) => /^https:\/\/hooks\.slack\.com\//.test(u || '');

export function slackConfig(env = process.env, overrides = {}) {
  const url = overrides.slackWebhookUrl ?? env.SLACK_WEBHOOK_URL ?? '';
  const urls = {};
  const ownUrl = ch => (overrides.slackUrls && overrides.slackUrls[ch]) ?? env[`SLACK_${ch.toUpperCase()}_WEBHOOK_URL`] ?? '';
  for (const ch of SLACK_CHANNELS) {
    const own = ownUrl(ch);
    const fb = FALLBACK[ch] ? ownUrl(FALLBACK[ch]) : '';
    const last = LAST_RESORT[ch] ? ownUrl(LAST_RESORT[ch]) : '';
    urls[ch] = isHook(own) ? own : isHook(fb) ? fb : isHook(url) ? url : isHook(last) ? last : '';
  }
  return {
    url,
    urls,
    enabled: SLACK_CHANNELS.some(ch => urls[ch]),
    // Railway sets these; they label which deploy sent the message.
    // SLACK_TOWN_TAG: "[Bay City] " before every title, so several towns can
    // share the same channels (MULTI_CITY_PLAN.md 4.3). Unset: no change.
    townTag: String(overrides.slackTownTag ?? env.SLACK_TOWN_TAG ?? '').trim(),
    environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'local',
    commit: (env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7)
  };
}

// A hung Slack must not hold a caller (the contact form awaits notify) for
// undici's default 300 s; past this a post counts as failed.
const POST_TIMEOUT_MS = 8000;

// Slack's answers that mean the webhook itself is dead (channel archived,
// app removed, token revoked), not a hiccup: retrying never helps and every
// later alert vanishes too, so these are remembered and shown in the admin
// checklist and the hourly site check instead of only logged.
const REFUSED_STATUSES = new Set([403, 404, 410]);
const REFUSED_ERRORS = new Set(['no_service', 'channel_is_archived', 'channel_not_found',
  'invalid_token', 'action_prohibited', 'no_active_hooks', 'team_disabled']);

export function createSlack(config, { fetchImpl = globalThis.fetch, nowFn = () => Date.now(), timeoutMs = POST_TIMEOUT_MS } = {}) {
  const lastAlert = new Map();
  // channel → { channel, status, error, at } for the last refused post;
  // cleared by the next post that goes through on that channel.
  const refusals = new Map();

  // Configs built by hand (tests) may only carry url.
  const urlFor = (channel) => (config.urls && config.urls[channel]) ||
    (isHook(config.url) ? config.url : '');

  async function post(text, blocks, channel = 'activity') {
    const url = urlFor(channel);
    if (!config.enabled || !url) return false;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(blocks ? { text, blocks } : { text }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.ok) {
        refusals.delete(channel);
        return true;
      }
      let error = '';
      try { error = typeof res.text === 'function' ? String(await res.text()).trim().slice(0, 100) : ''; } catch { /* no body */ }
      console.warn('[slack] HTTP', res.status, error);
      if (REFUSED_STATUSES.has(res.status) || REFUSED_ERRORS.has(error)) {
        refusals.set(channel, { channel, status: res.status, error, at: new Date(nowFn()).toISOString() });
      }
      return false;
    } catch (err) {
      console.warn('[slack] send failed:', err.message);
      return false;
    }
  }

  // A titled message with optional "label: value" fields and a footer line.
  function notify({ title, fields = [], text = '', link = null, linkLabel = 'Open', footer = '', channel = 'activity' }) {
    const e = slackEscape;
    if (config.townTag) title = `[${config.townTag}] ${title}`;
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: String(title).slice(0, 150) } }];
    const f = fields.filter(([, v]) => v != null && v !== '').slice(0, 10)
      .map(([k, v]) => ({ type: 'mrkdwn', text: `*${e(k)}*\n${e(v).slice(0, 500)}` }));
    if (f.length) blocks.push({ type: 'section', fields: f });
    if (text) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: e(text).slice(0, 2900) } });
    const ctx = [footer, link ? `<${link}|${linkLabel}>` : '', config.environment !== 'production' ? `env: ${config.environment}` : '']
      .filter(Boolean).join(' · ');
    if (ctx) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ctx }] });
    return post(String(title), blocks, channel);
  }

  // Something broke. Pings once per key per window.
  function alert(key, title, detail = '', link = null) {
    const now = nowFn();
    const last = lastAlert.get(key);
    if (last !== undefined && now - last < ALERT_WINDOW_MS) return Promise.resolve(false);
    lastAlert.set(key, now);
    return notify({ title: `🚨 ${title}`, text: detail, link, footer: config.commit ? `deploy ${config.commit}` : '', channel: 'alerts' });
  }

  // Channels whose webhook Slack refused, most recent first.
  const refused = () => [...refusals.values()].sort((a, b) => (a.at < b.at ? 1 : -1));

  // Whether an alert has a webhook to go to (the setup checklist).
  return { enabled: config.enabled, alertsRouted: config.enabled && Boolean(urlFor('alerts')), notify, alert, post, refused };
}
