/* server/emailTypos.js — Catch a mistyped email before we lose the person.
 *
 * Why: a Star 402 organizer typed "...@gmail.comm". The address passed the
 * format check, so the "we got it" and "you're live" emails bounced and
 * nobody knew. Two layers:
 *   - an ending no email can have (.comm, .con, .cmo...) is refused at the
 *     server with the fix in the message ("Did you mean ...@gmail.com?"),
 *     on every form that takes an email;
 *   - a likely slip on a real-looking address (gmial.com, yahoo.co) only
 *     gets a "Did you mean" note in the browser (GET /emailcheck.js), and
 *     the first submit waits for them to look; a second goes through.
 *
 * suggestEmail must stay self-contained (no names from outside its body):
 * the browser runs this exact function's source, so the note and the
 * server check can't drift apart.
 */

export function suggestEmail(raw) {
  // Endings that are not top-level domains, each one key away from a real
  // one. Real short ones (.co, .cm, .om, .ne, .et) are never here.
  var ENDINGS = {
    comm: 'com', con: 'com', cmo: 'com', ocm: 'com', vom: 'com', xom: 'com', cpm: 'com', coom: 'com',
    comn: 'com', copm: 'com', cim: 'com', clm: 'com', ccom: 'com', comk: 'com',
    nte: 'net', nett: 'net', ner: 'net', ogr: 'org', orgg: 'org', rog: 'org', edi: 'edu', eud: 'edu'
  };
  // Misspelled big providers. These could be real domains, so they're only
  // ever a suggestion.
  var DOMAINS = {
    'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com',
    'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com',
    'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhoo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.cm': 'yahoo.com',
    'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
    'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'outlook.co': 'outlook.com',
    'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com', 'icloud.co': 'icloud.com', 'aol.co': 'aol.com'
  };
  var e = String(raw == null ? '' : raw).trim().toLowerCase();
  var at = e.lastIndexOf('@');
  if (at < 1) return null;
  var user = e.slice(0, at);
  var domain = e.slice(at + 1);
  if (DOMAINS[domain]) return { email: user + '@' + DOMAINS[domain], impossible: false };
  var dot = domain.lastIndexOf('.');
  if (dot < 1) return null;
  var fixed = ENDINGS[domain.slice(dot + 1)];
  if (!fixed) return null;
  var d = domain.slice(0, dot + 1) + fixed;
  return { email: user + '@' + (DOMAINS[d] || d), impossible: true };
}

// The server's half: an error message when the ending can't be real, else
// ''. The message carries the fix so the person can correct it at once.
export function impossibleEmailError(raw) {
  const s = suggestEmail(raw);
  return s && s.impossible ? `That email can't receive mail. Did you mean ${s.email}?` : '';
}

// GET /emailcheck.js: the browser's "Did you mean" note on every email field.
// A suggestion shows when they leave the field; the first submit with one
// still showing waits (they may not have looked), the next goes through as
// typed, so nobody is stopped by a guess.
export const EMAIL_CHECK_JS = `/* /emailcheck.js — built from server/emailTypos.js */
(function () {
  if (window.vicEmailCheck) return;
  var suggest = ${suggestEmail.toString()};
  function hintFor(input, make) {
    var h = input.__vicHint;
    if (!h && make) {
      h = document.createElement('p');
      h.className = 'email-hint';
      h.setAttribute('role', 'status');
      input.insertAdjacentElement('afterend', h);
      input.__vicHint = h;
    }
    return h;
  }
  function clear(input) {
    var h = hintFor(input, false);
    if (h) { h.remove(); input.__vicHint = null; }
  }
  // Shows the note; returns whether there was one.
  function check(input) {
    var s = suggest(input.value);
    if (!s || s.email === input.value.trim().toLowerCase()) { clear(input); return false; }
    var h = hintFor(input, true);
    // Already showing this one: leave it. Tapping the fix moves focus out
    // of the field, and rebuilding here swapped the button out from under
    // the tap, so the fix never applied.
    if (h.__for === s.email) return true;
    h.__for = s.email;
    h.textContent = 'Did you mean ';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'email-hint__fix';
    b.textContent = s.email;
    b.addEventListener('click', function () {
      input.value = s.email;
      clear(input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
    });
    h.append(b, '?');
    return true;
  }
  var isEmail = function (el) { return el && el.matches && el.matches('input[type=email]'); };
  document.addEventListener('focusout', function (e) { if (isEmail(e.target)) check(e.target); });
  document.addEventListener('input', function (e) { if (isEmail(e.target) && e.target.__vicHint) check(e.target); });
  // Capture on window runs before every form's own submit handling.
  window.addEventListener('submit', function (e) {
    var form = e.target;
    var inputs = form && form.querySelectorAll ? form.querySelectorAll('input[type=email]') : [];
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      if (input.__vicAsked === input.value) continue;
      if (check(input)) {
        input.__vicAsked = input.value;
        e.preventDefault();
        e.stopImmediatePropagation();
        input.focus();
        return;
      }
    }
  }, true);
  window.vicEmailCheck = { suggest: suggest, check: check };
})();
`;
