/* server/formGuard.js — No visitor stuck on a public form, and we hear about it.
 *
 * Why: on Oct 12 someone on a VPN tried to submit a free event three times,
 * got "We couldn't verify you aren't a bot" each time, gave up and emailed
 * instead. Nothing told the owner. Cloudflare's check fails for real people
 * (an ad blocker or privacy browser blocks its script, a VPN gets a puzzle,
 * a token expires while they type, Cloudflare itself is slow), so the public
 * forms no longer refuse on it: what was sent goes through, labeled, and the
 * owner checks it (a free event waits for his OK; a paid one still has to
 * get through Stripe; a contact message is labeled in Slack). The honeypot,
 * timing check and rate limits still stop the bulk of bots.
 *
 * This module is the "we know about it" half:
 *   botCheck()        the Turnstile result, logged and alerted when it fails
 *   rejected()/ok()   a visitor turned away STUCK_AFTER times in a row on one
 *                     form, without getting through, is alerted with what
 *                     the form kept saying
 *   POST /api/form-problem  the browser reports what the server can't see
 *                     (the request never arrived, an answer it couldn't
 *                     read, a script error in the form)
 *
 * Alerts go through slack.alert (the alerts channel, once per key per 15
 * minutes), so a burst of bot traffic is one message, not a flood.
 */

export const FORMS = {
  submit: 'free event form (/submit)',
  checkout: 'paid checkout (/advertise/checkout)',
  contact: 'contact form (/contact)',
  subscribe: 'newsletter signup'
};

// What the browser may report (POST /api/form-problem `stage`).
export const CLIENT_STAGES = new Set(['network', 'server', 'script']);

const STUCK_AFTER = 3;
const STUCK_WINDOW_MS = 30 * 60 * 1000;
const MAX_TRACKED = 2000;

// A short browser name for the alert, so "Edge on Windows" or "Facebook
// app" is visible without reading a user-agent string.
export function browserLabel(ua) {
  const s = String(ua || '');
  if (!s) return 'unknown browser';
  if (/FBAN|FBAV/.test(s)) return 'Facebook app';
  if (/Instagram/.test(s)) return 'Instagram app';
  const os = /iPhone|iPad/.test(s) ? 'iPhone/iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows'
    : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'unknown OS';
  const name = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'other browser';
  return `${name} on ${os}`;
}

// For a route registered without a guard (unit tests of one module): the
// old yes/no check, no alerts.
export function passiveGuard(verifyHuman = async () => true) {
  return {
    botCheck: async (form, req) => ((await verifyHuman(req)) ? { ok: true } : { ok: false, error: 'verification-failed' }),
    rejected() {}, ok() {}
  };
}

export function createFormGuard({ slack, verifyTurnstile, turnstileOpts = () => ({}), clientKey = req => req.ip, nowFn = () => Date.now() }) {
  const streaks = new Map();
  const label = form => FORMS[form] || form;

  // The Turnstile result for this request ({ ok, error, disabled }). When it
  // fails the caller still lets the visitor through (except a token solved
  // on another site, which no real visitor of ours sends); this says so.
  async function botCheck(form, req, token) {
    let r;
    try {
      r = await verifyTurnstile(typeof token === 'string' ? token : '', { remoteip: req.ip, ...turnstileOpts() });
    } catch (err) {
      r = { ok: false, error: 'network-error', detail: err.message };
    }
    if (!r.ok) {
      const ua = req.get ? req.get('user-agent') : '';
      const why = [r.error, ...(r.codes || [])].filter(Boolean).join(', ');
      console.warn('[turnstile] did not pass:', req.path, why, '·', browserLabel(ua));
      if (r.error !== 'hostname-mismatch') {
        slack.alert(`form-bot:${form}`, `Bot check didn't pass on the ${label(form)}`,
          `${browserLabel(ua)} (${why}). They were let through and it's labeled so you can check it. ` +
          'One now and then is a blocked script or a VPN; many in a row means the check itself is broken.');
      }
    }
    return r;
  }

  // The form turned this visitor away (field errors, a full day...).
  function rejected(form, req, reasons = []) {
    const key = `${form}:${clientKey(req)}`;
    const now = nowFn();
    let s = streaks.get(key);
    if (!s || now - s.last > STUCK_WINDOW_MS) s = { count: 0, first: now, reasons: [] };
    s.count += 1;
    s.last = now;
    s.reasons = [...new Set([...s.reasons, ...reasons.map(String)])].slice(-8);
    streaks.delete(key);
    streaks.set(key, s);
    if (streaks.size > MAX_TRACKED) streaks.delete(streaks.keys().next().value);
    if (s.count === STUCK_AFTER) {
      const mins = Math.max(1, Math.round((now - s.first) / 60000));
      const ua = req.get ? req.get('user-agent') : '';
      slack.alert(`form-stuck:${form}`, `Someone is stuck on the ${label(form)}`,
        `${s.count} tries in ${mins} min from one visitor (${browserLabel(ua)}), still not through. ` +
        `What the form told them: ${s.reasons.join(' · ') || 'no reason recorded'}.`);
    }
  }

  // The visitor got through: their streak is over.
  function ok(form, req) {
    streaks.delete(`${form}:${clientKey(req)}`);
  }

  // The browser's own report. Small and rate limited: it only ever becomes
  // a (de-duplicated) alert, never stored.
  function registerRoutes(app, { limiter }) {
    app.post('/api/form-problem', (req, res) => {
      const b = req.body || {};
      const form = String(b.form || '');
      const stage = String(b.stage || '');
      if (!FORMS[form] || !CLIENT_STAGES.has(stage)) return res.status(400).json({ ok: false, error: 'bad-report' });
      if (!limiter.check(`form-problem:${clientKey(req)}`).ok) return res.status(429).json({ ok: false, error: 'rate-limited' });
      const detail = String(b.detail || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const ua = req.get('user-agent');
      console.warn('[form-problem]', form, stage, detail, '·', browserLabel(ua));
      const what = {
        network: "couldn't reach the server",
        server: 'got an answer it could not use',
        script: 'hit an error in the page'
      }[stage];
      slack.alert(`form-client:${form}:${stage}`, `A visitor's ${label(form)} ${what}`,
        `${browserLabel(ua)}${detail ? `: ${detail}` : ''}. The page offered them the contact form so they aren't stuck.`);
      res.status(204).end();
    });
  }

  return { botCheck, rejected, ok, registerRoutes, streaks };
}
