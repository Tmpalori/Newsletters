/* docs/turnstile.js — Cloudflare Turnstile for the public forms.
 *
 * Forms marked data-turnstile get an invisible check ("interaction-only":
 * real people almost never see it; Cloudflare only shows a box when it's
 * unsure). The widget loads the first time someone focuses a field, so pages
 * stay light. Turnstile adds a hidden cf-turnstile-response field to the form,
 * which regular form posts send as-is; fetch-based forms call
 * vicTurnstile.token(form). With no site key configured this does nothing and
 * the server skips the check too.
 */
(function () {
  if (window.vicTurnstile) return;
  var cfg = null, cfgP = null, scriptP = null;

  function config() {
    if (cfgP) return cfgP;
    cfgP = fetch('/api/config').then(function (r) { return r.json(); })
      .then(function (c) { cfg = c || {}; return cfg; })
      .catch(function () { cfg = {}; return cfg; });
    return cfgP;
  }

  // Settles even when Cloudflare's script never arrives (an ad blocker, a
  // strict in-app browser, a network error): then there's no widget, the
  // form sends no token, and the server asks the reader to confirm by email.
  function loadScript() {
    if (scriptP) return scriptP;
    scriptP = new Promise(function (resolve) {
      if (window.turnstile && window.turnstile.render) return resolve();
      window.__vicTsLoaded = resolve;
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__vicTsLoaded&render=explicit';
      s.async = true;
      s.onerror = function () { resolve(); };
      setTimeout(resolve, 8000);
      document.head.appendChild(s);
    });
    return scriptP;
  }

  function mount(form) {
    if (form.__vicTs) return form.__vicTs;
    form.__vicTs = config().then(function (c) {
      if (!c.turnstile_site_key) return null;
      return loadScript().then(function () {
        if (!window.turnstile || !window.turnstile.render) return null; // never loaded
        var box = document.createElement('div');
        box.className = 'ts-mount';
        var btn = form.querySelector('[type=submit]');
        form.insertBefore(box, btn || null);
        var state = { token: '', waiters: [] };
        try {
          state.id = window.turnstile.render(box, {
            sitekey: c.turnstile_site_key,
            appearance: 'interaction-only',
            callback: function (t) { state.token = t; state.waiters.splice(0).forEach(function (w) { w(t); }); },
            'expired-callback': function () { state.token = ''; },
            'error-callback': function () { state.token = ''; }
          });
        } catch (err) { return null; }
        return state;
      });
    }).catch(function () { return null; });
    return form.__vicTs;
  }

  // Resolves with the token ('' when Turnstile is off), waiting briefly for
  // Cloudflare to finish if needed.
  // Never hangs: whatever goes wrong, the form gets '' within 12 seconds.
  function token(form) {
    var answer = mount(form).then(function (state) {
      if (!state) return '';
      if (state.token) return state.token;
      return new Promise(function (resolve) {
        state.waiters.push(resolve);
        setTimeout(function () { resolve(state.token || ''); }, 10000);
      });
    });
    return Promise.race([answer, new Promise(function (resolve) { setTimeout(function () { resolve(''); }, 12000); })]);
  }

  function reset(form) {
    if (form.__vicTs) form.__vicTs.then(function (s) {
      if (s && window.turnstile) { s.token = ''; window.turnstile.reset(s.id); }
    });
  }

  document.addEventListener('focusin', function (e) {
    var f = e.target && e.target.closest && e.target.closest('form[data-turnstile]');
    if (f) mount(f);
  });

  // Regular (non-fetch) forms: hold the submit until the token is in.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.matches || !f.matches('form[data-turnstile]:not([data-turnstile=fetch])') || f.__vicTsReady) return;
    e.preventDefault();
    token(f).then(function () { f.__vicTsReady = true; f.submit(); });
  }, true);

  // What the server can't see on a fetch-based form (the request never
  // arrived, an answer it couldn't use) goes to the owner as a Slack alert
  // (POST /api/form-problem, server/formGuard.js). Never throws.
  function report(form, stage, detail) {
    try {
      fetch('/api/form-problem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ form: form, stage: stage, detail: String(detail || '').slice(0, 300) })
      }).catch(function () {});
    } catch (e) { /* nothing more to do */ }
  }

  window.vicTurnstile = { token: token, reset: reset, report: report };
})();
