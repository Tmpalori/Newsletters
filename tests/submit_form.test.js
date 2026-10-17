// Smoke test for the public submit-an-event page (docs/submit.html +
// submit.js). Verifies the form structure, honeypot wiring, and the data
// shape collectForm() will POST to /api/submissions.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'submit.html'), 'utf8');
const JS = readFileSync(resolve(DOCS, 'submit.js'), 'utf8');

function bootDom() {
  const bodyMatch = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  document.querySelectorAll('script[src*="submit.js"]').forEach(s => s.remove());

  delete window.__vic361Submit;
  // Stub fetch so init() doesn't try to talk to a real /api/config.
  window.fetch = async () => ({ ok: false, json: async () => null });
  window.scrollTo = () => {}; // jsdom doesn't implement it
  // eslint-disable-next-line no-eval
  (0, eval)(JS);
  return window.__vic361Submit;
}

describe('submit.html structure', () => {
  beforeEach(() => bootDom());

  it('exposes the form, honeypot, and turnstile mount', () => {
    const ids = [
      'submit-form', 'f-name', 'f-date', 'f-time', 'f-end', 'f-venue',
      'f-address', 'f-url', 'f-desc', 'f-icons', 'f-hp-field', 'f-turnstile',
      'submit-btn', 'thanks-card', 'submit-another', 'form-error'
    ];
    for (const id of ids) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }
  });

  it('honeypot field is in DOM but visually hidden', () => {
    const hp = document.getElementById('f-hp-field');
    expect(hp).not.toBeNull();
    const wrap = hp.closest('.hp-field');
    expect(wrap).not.toBeNull();
  });

  it('renders a fieldset for submitter type with three options', () => {
    const opts = document.querySelectorAll('input[name="submitter_kind"]');
    expect(opts.length).toBe(3);
    expect(Array.from(opts).map(o => o.value).sort()).toEqual(['found_online', 'organizer', 'other']);
  });

  it('offers early-morning start times (a 6:30 AM fun run is not forced to 7:00 AM)', () => {
    const starts = Array.from(document.querySelectorAll('#f-time option')).map(o => o.value);
    expect(starts).toEqual(expect.arrayContaining(['5:00 AM', '6:00 AM', '6:30 AM', '7:00 AM', '1:30 AM']));
  });

  it('exposes category checkboxes from the allow-list', () => {
    const cats = Array.from(document.querySelectorAll('input[name="icons"]')).map(c => c.value);
    expect(cats).toEqual(expect.arrayContaining(['music', 'food', 'family', 'community']));
  });

  it('marks description as required and exposes a field-error slot for it', () => {
    const desc = document.getElementById('f-desc');
    expect(desc).not.toBeNull();
    expect(desc.required).toBe(true);
    const err = document.querySelector('[data-error-for="description"]');
    expect(err).not.toBeNull();
  });
});

describe('submit.js — collectForm()', () => {
  let api;
  beforeEach(() => { api = bootDom(); });

  function fill(values) {
    for (const [name, val] of Object.entries(values)) {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(val);
      else el.value = val;
    }
  }

  it('returns the canonical event shape with bot-signal extras', () => {
    // Time is a select now — populate it first so it has options to pick.
    api.populateTimeSelects();
    fill({
      name: 'Test', date: '2026-05-12', time: '7:00 PM',
      venue: 'V', address: 'A', url: 'https://x.test',
      description: 'd',
      submitter_first_name: 'Jane', submitter_last_name: 'Doe',
      submitter_email: 'j@x.com', submitter_phone: '(361) 555-0000'
    });
    document.querySelector('input[name="icons"][value="music"]').checked = true;
    api.setTurnstileToken('cf-token');
    const out = api.collectForm();
    expect(out.name).toBe('Test');
    expect(out.icons).toContain('music');
    expect(out.turnstile_token).toBe('cf-token');
    expect(typeof out.elapsed_ms).toBe('number');
    expect(out.hp_field).toBe('');
    expect(out.submitter_kind).toBe('organizer');
    expect(out.submitter_first_name).toBe('Jane');
    expect(out.submitter_last_name).toBe('Doe');
    expect(out.submitter_name).toBe('Jane Doe');
    expect(out.submitter_phone).toBe('(361) 555-0000');
  });

  it('"Submit another" restarts the form timer', () => {
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0 + 2 * 60 * 60 * 1000);
    try {
      document.getElementById('submit-another').click();
      spy.mockReturnValue(t0 + 2 * 60 * 60 * 1000 + 30000);
      expect(api.collectForm().elapsed_ms).toBe(30000);
    } finally { spy.mockRestore(); }
  });

  it('honeypot value is included in the payload (server detects it)', () => {
    fill({ name: 'X', date: '2026-05-12', time: '7 PM', venue: 'V', hp_field: 'AcmeBots' });
    const out = api.collectForm();
    expect(out.hp_field).toBe('AcmeBots');
    // Never sent as "company", the autofill name it used to have.
    expect(out).not.toHaveProperty('company');
  });
});

describe('submit form: errors you can see, phone formatting', () => {
  let api;
  beforeEach(() => { api = bootDom(); });

  it('formats full US phone numbers and leaves international ones alone', () => {
    expect(['3615550100', '13615550100', '(361)5550100', '361-555-0100', '1 361 555 0100']
      .map(api.formatPhone)).toEqual(Array(5).fill('(361) 555-0100'));
    expect(api.formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(api.formatPhone('')).toBe('');
  });

  it('leaves short local numbers and partial input as typed (no made-up area code)', () => {
    for (const v of ['555-0123', '5550123', '361', '361555', '36155501001']) expect(api.formatPhone(v)).toBe(v);
  });

  it('keeps extensions', () => {
    for (const v of ['(361) 555-0100 x12', '(361) 555-0100 ext. 4', '361-555-0100 #7', '3615550100x']) {
      expect(api.formatPhone(v)).toBe(v);
    }
  });

  it('live formatting does not eat a space typed after the number', () => {
    const phone = document.getElementById('f-sub-phone');
    const type = v => { phone.value = v; phone.setSelectionRange(v.length, v.length); phone.dispatchEvent(new Event('input', { bubbles: true })); };
    type('3615550100'); expect(phone.value).toBe('(361) 555-0100');
    type('(361) 555-0100 '); expect(phone.value).toBe('(361) 555-0100 ');
    type('(361) 555-0100 x1'); expect(phone.value).toBe('(361) 555-0100 x1');
  });

  it('accepts 7+ digit phones like the server does', () => {
    const base = { name: 'Show', date: '2026-10-17', time: '7:00 PM', venue: 'V', address: 'A', description: 'D', free: false,
      submitter_first_name: 'Pat', submitter_last_name: 'Lee', submitter_email: 'p@x.com' };
    expect(api.checkForm({ ...base, submitter_phone: '555-0123' })).toEqual({});
    expect(api.checkForm({ ...base, submitter_phone: '+64 9 123 4567' })).toEqual({});
    expect(api.checkForm({ ...base, submitter_phone: '555-012' })).toEqual({ submitter_phone: 'Phone number looks invalid.' });
  });

  it('catches missing and bad fields before sending, with the server’s wording', () => {
    const errs = api.checkForm({ name: 'Show', date: '2026-10-17', time: '7:00 PM', venue: 'V', address: 'A',
      description: 'D', submitter_first_name: 'Pat', submitter_last_name: '', submitter_email: 'nope', submitter_phone: '555-01' });
    expect(errs).toEqual({ submitter_last_name: 'Last name is required.', submitter_email: 'Email looks invalid.',
      submitter_phone: 'Phone number looks invalid.', free: 'Choose free or paid.' });
  });

  it('makes the organizer choose free or paid (no default that lists a ticketed show as free)', () => {
    const radios = [...document.querySelectorAll('input[name="free"]')];
    expect(radios.some(r => r.checked)).toBe(false);
    expect(api.collectForm().free).toBe(null);
    expect(document.getElementById('sp-free').hidden).toBe(true);
    document.querySelector('input[name="free"][value="false"]').checked = true;
    expect(api.collectForm().free).toBe(false);
    document.querySelector('input[name="free"][value="true"]').checked = true;
    expect(api.collectForm().free).toBe(true);
  });

  it('outlines each problem field, names the problems by the button, and focuses the first', () => {
    api.showErrors({ submitter_phone: 'Phone number is required.', time: 'Start time is required.' });
    expect(document.querySelector('[name="submitter_phone"]').getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[name="time"]').getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[data-error-for="submitter_phone"]').textContent).toBe('Phone number is required.');
    const fe = document.getElementById('form-error');
    expect(fe.hidden).toBe(false);
    expect(fe.textContent).toBe('Please fix: Phone number is required. Start time is required.');
    expect(document.activeElement.name).toBe('submitter_phone');
  });

  it('ties each message to its field for screen readers and clears it on fix', () => {
    api.showErrors({ submitter_email: 'Email looks invalid.' });
    const input = document.querySelector('[name="submitter_email"]');
    const msg = document.getElementById(input.getAttribute('aria-describedby'));
    expect(input.getAttribute('aria-describedby')).toBe('err-submitter_email');
    expect(msg.textContent).toBe('Email looks invalid.');
    expect(document.getElementById('form-error').getAttribute('role')).toBe('alert');
    input.value = 'p@x.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    api.showErrors({ submitter_email: 'Email looks invalid.' });
    document.getElementById('submit-another').click();
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('submit form: live preview and site icons', () => {
  let api;
  beforeEach(() => { api = bootDom(); });

  it('uses the site’s drawn icons instead of emoji', () => {
    const chips = [...document.querySelectorAll('#f-icons .chip')];
    expect(chips).toHaveLength(8);
    chips.forEach(c => expect(c.querySelector('use').getAttribute('href')).toMatch(/^\/icons\.svg#i-/));
    expect(document.getElementById('f-icons').textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('shows the listing as they type it', () => {
    const set = (n, v) => { document.querySelector(`#submit-form [name="${n}"]`).value = v; };
    set('name', '<b>Fall Fest</b>'); set('date', '2026-10-17'); set('venue', 'De Leon Plaza');
    set('description', 'Music and food.');
    const time = document.querySelector('#submit-form [name="time"]');
    time.value = time.options[2].value;
    document.querySelector('input[name="icons"][value="music"]').checked = true;
    document.querySelector('input[name="free"][value="true"]').checked = true;
    api.updatePreview();
    expect(document.getElementById('sp-day').textContent).toBe('Saturday');
    expect(document.getElementById('sp-date').textContent).toBe('October 17');
    expect(document.getElementById('sp-name').textContent).toBe('<b>Fall Fest</b>');   // text, not HTML
    expect(document.getElementById('sp-name').innerHTML).toContain('&lt;b&gt;');
    expect(document.getElementById('sp-time').textContent).toBe(time.options[2].value);
    expect([...document.querySelectorAll('#sp-icons use')].map(u => u.getAttribute('href')))
      .toEqual(['/icons.svg#i-music', '/icons.svg#i-free']);
  });

  it('"Submit another" clears the preview and puts today back in the date', () => {
    const set = (n, v) => { document.querySelector(`#submit-form [name="${n}"]`).value = v; };
    set('name', 'Fall Fest'); set('date', '2026-10-17'); set('venue', 'De Leon Plaza');
    api.updatePreview();
    expect(document.getElementById('sp-name').textContent).toBe('Fall Fest');
    document.getElementById('submit-another').click();
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(document.getElementById('f-date').value).toBe(today);
    expect(document.getElementById('sp-name').textContent).toBe('Your event name');
    expect(document.getElementById('sp-venue').textContent).toBe('Venue');
    expect(document.getElementById('sp-day').textContent).toBe(d.toLocaleDateString('en-US', { weekday: 'long' }));
  });
});


// The real page has <meta name="description"> in <head>. bootDom() above only
// loads <body>, which hid a bug where collectForm() read the meta tag instead
// of the textarea and every submission failed "Description is required."
describe('submit.js with the real <head> in the page', () => {
  it('reads the description textarea, not <meta name="description">', () => {
    const headMatch = HTML.match(/<head>([\s\S]*?)<\/head>/);
    const api = bootDom();
    document.head.innerHTML = (headMatch ? headMatch[1] : '').replace(/<script[\s\S]*?<\/script>/g, '');
    expect(document.querySelector('meta[name="description"]')).not.toBeNull();
    api.populateTimeSelects();
    const set = (n, v) => { document.querySelector(`#submit-form [name="${n}"]`).value = v; };
    set('name', 'Early Voting'); set('date', '2026-10-20'); set('time', '8:00 AM');
    set('venue', 'Victoria County Courthouse'); set('address', '101 N Bridge St');
    set('description', 'Early voting for the November election.');
    set('submitter_first_name', 'Pat'); set('submitter_last_name', 'Lee');
    set('submitter_email', 'pat@example.com'); set('submitter_phone', '(361) 555-0123');
    document.querySelector('input[name="free"][value="true"]').checked = true;
    const out = api.collectForm();
    expect(out.description).toBe('Early voting for the November election.');
    expect(api.checkForm(out)).toEqual({});
  });
});

describe('a link can prefill the event (a reply to someone who emailed it in)', () => {
  it('fills event fields from the query, as values; skips bad dates, unknown times and contact fields', () => {
    window.history.replaceState(null, '', '/submit?' + new URLSearchParams({
      name: 'Fall Festival <b>x</b>', date: '2099-10-26', time: '10:00 AM', end_time: '25:00 PM', venue: 'St. Mary\'s Hall',
      description: 'Games\nand food', submitter_email: 'pat@example.com' }));
    bootDom();
    const v = id => document.getElementById(id).value;
    expect(v('f-name')).toBe('Fall Festival <b>x</b>');
    expect(document.querySelector('#f-name').parentElement.querySelector('b')).toBeNull();
    expect(v('f-date')).toBe('2099-10-26');
    expect(v('f-time')).toBe('10:00 AM');
    expect(v('f-end')).toBe('');
    expect(v('f-venue')).toBe('St. Mary\'s Hall');
    expect(v('f-desc')).toBe('Games\nand food');
    expect(document.querySelector('#submit-form [name="submitter_email"]').value).toBe('');
    window.history.replaceState(null, '', '/submit?date=next-week');
    bootDom();
    expect(v('f-date')).not.toBe('next-week');
    window.history.replaceState(null, '', '/');
  });
});


describe('submitting never dead-ends (Oct 12: three tries, then gave up)', () => {
  let api, calls;

  function fillValid() {
    api.populateTimeSelects();
    const set = (name, v) => { document.querySelector(`#submit-form [name="${name}"]`).value = v; };
    set('name', 'Fall Fest'); set('date', '2026-10-24'); set('time', '7:00 PM'); set('venue', 'Main Plaza');
    set('address', '101 Main St'); set('description', 'Music and food.');
    set('submitter_first_name', 'Jane'); set('submitter_last_name', 'Doe');
    set('submitter_email', 'jane@example.com'); set('submitter_phone', '(361) 555-0100');
    document.querySelector('input[name="free"][value="true"]').checked = true;
  }
  // Records every request; `answer` decides /api/submissions' reply.
  function stubFetch(answer) {
    calls = [];
    window.fetch = async (url, init = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === '/api/submissions') return answer();
      return { ok: false, json: async () => null };
    };
  }
  const submitted = () => calls.filter(c => c.url === '/api/submissions');
  const reports = () => calls.filter(c => c.url === '/api/form-problem').map(c => c.body);
  const created = () => ({ ok: true, status: 201, json: async () => ({ ok: true, queued: true, id: 'x1' }) });
  const submit = () => api.handleSubmit({ preventDefault() {} });

  beforeEach(() => { api = bootDom(); delete window.turnstile; });

  it('waits for a bot check still in progress, then sends its token', async () => {
    let widget;
    window.turnstile = { render: (el, o) => { widget = o; return 'w1'; } };
    api.injectTurnstile('site-key');
    expect(api.turnstileState()).toBe('loading');
    fillValid();
    stubFetch(created);
    const done = submit();
    await new Promise(r => setTimeout(r, 20));
    expect(submitted()).toEqual([]);
    expect(document.getElementById('submit-btn').textContent).toMatch(/Checking/);
    widget.callback('cf-token');
    await done;
    expect(submitted()[0].body.turnstile_token).toBe('cf-token');
    expect(document.getElementById('thanks-card').hidden).toBe(false);
  });

  it('sends anyway when the check never finishes (the server takes it, labeled)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      window.turnstile = { render: () => 'w1' };
      api.injectTurnstile('site-key');
      fillValid();
      stubFetch(created);
      const done = submit();
      await vi.advanceTimersByTimeAsync(10000);
      await done;
    } finally { vi.useRealTimers(); }
    expect(submitted()).toHaveLength(1);
    expect(submitted()[0].body.turnstile_token).toBeNull();
    expect(document.getElementById('thanks-card').hidden).toBe(false);
  });

  it('does not wait when the check failed to load (an ad blocker, a strict browser)', async () => {
    window.turnstile = { render: () => { throw new Error('blocked'); } };
    api.injectTurnstile('site-key');
    expect(api.turnstileState()).toBe('failed');
    fillValid();
    stubFetch(created);
    await submit();
    expect(submitted()).toHaveLength(1);
    expect(document.getElementById('thanks-card').hidden).toBe(false);
  });

  it('a network failure is reported, gives the button back, and offers the contact form', async () => {
    fillValid();
    stubFetch(() => { throw new TypeError('Failed to fetch'); });
    await submit();
    expect(reports()).toEqual([{ form: 'submit', stage: 'network', detail: 'Failed to fetch' }]);
    const btn = document.getElementById('submit-btn');
    expect(btn.disabled).toBe(false);
    const fe = document.getElementById('form-error');
    expect(fe.hidden).toBe(false);
    expect(fe.querySelector('a').getAttribute('href')).toBe('/contact?topic=event');
  });

  it('an answer it cannot use (a 500, a proxy page) is reported as a server problem', async () => {
    fillValid();
    stubFetch(() => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }));
    await submit();
    expect(reports()).toEqual([{ form: 'submit', stage: 'server', detail: 'HTTP 502' }]);
    expect(document.getElementById('form-error').querySelector('a')).not.toBeNull();
  });

  it('field errors from the server are shown, not reported (the server counts those)', async () => {
    fillValid();
    stubFetch(() => ({ ok: false, status: 400, json: async () => ({ ok: false, errors: { url: 'Link must be a valid website (e.g. example.com).' } }) }));
    await submit();
    expect(reports()).toEqual([]);
    expect(document.querySelector('[data-error-for="url"]').textContent).toContain('valid website');
  });

  it('an error in the page itself is reported and never leaves the button stuck', async () => {
    fillValid();
    stubFetch(() => ({ get ok() { throw new Error('boom'); }, status: 200, json: async () => ({}) }));
    await submit();
    expect(reports()).toEqual([{ form: 'submit', stage: 'script', detail: 'boom' }]);
    expect(document.getElementById('submit-btn').disabled).toBe(false);
  });
});
