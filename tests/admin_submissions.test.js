// Admin Submissions tab smoke tests + source pill rendering + private-field
// stripping. Loads docs/admin.html into jsdom and evaluates both admin.js and
// admin-submissions.js so we can assert on the rendered DOM and the exposed
// helpers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '..', 'docs');
const HTML = readFileSync(resolve(DOCS, 'admin.html'), 'utf8');
const ADMIN_JS = readFileSync(resolve(DOCS, 'admin.js'), 'utf8');
const SUB_JS = readFileSync(resolve(DOCS, 'admin-submissions.js'), 'utf8');

function bootDom({ pat = null, apiBase = '', token = '' } = {}) {
  const bodyMatch = HTML.match(/<body>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  document.querySelectorAll('script[src*="admin"]').forEach(s => s.remove());

  delete window.__vic361Admin;
  delete window.__vic361Submissions;
  window.localStorage.clear();
  if (pat) window.localStorage.setItem('vic361_admin_pat', pat);
  if (apiBase) window.localStorage.setItem('vic361_submissions_api_url', apiBase);
  if (token) window.localStorage.setItem('vic361_submissions_admin_token', token);

  // admin.js calls /api/config and /api/admin/me on init. Stub them out in
  // jsdom so init() doesn't hang on a real network call.
  window.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/admin/me')) {
      return { ok: false, status: 401, json: async () => ({ ok: false }) };
    }
    if (u.includes('/api/config')) {
      return { ok: true, status: 200, json: async () => ({
        admin_login_enabled: false,
        admin_legacy_token_enabled: false,
        github_publish_enabled: false
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  // eslint-disable-next-line no-eval
  (0, eval)(ADMIN_JS);
  // eslint-disable-next-line no-eval
  (0, eval)(SUB_JS);
  return {
    admin: window.__vic361Admin,
    submissions: window.__vic361Submissions
  };
}

describe('admin Submissions tab — DOM', () => {
  beforeEach(() => bootDom());

  it('renders a Submissions sub-tab under Events', () => {
    const sub = document.querySelector('.subtab-btn[data-goto="submissions"]');
    expect(sub).not.toBeNull();
    expect(sub.dataset.in).toBe('picker');
  });

  it('exposes the submissions panel and its config inputs', () => {
    const ids = [
      'tab-submissions', 'submissions-api-url', 'submissions-admin-token',
      'submissions-save-config', 'submissions-status', 'submissions-refresh',
      'submissions-pull-approved', 'submissions-list', 'submissions-empty',
      'submissions-error', 'submissions-pending-badge'
    ];
    for (const id of ids) {
      expect(document.getElementById(id), `missing #${id}`).not.toBeNull();
    }
  });

  it('persists config inputs to localStorage on Save', () => {
    document.getElementById('submissions-api-url').value = 'https://example.up.railway.app/';
    document.getElementById('submissions-admin-token').value = 'tok-abc';
    document.getElementById('submissions-save-config').click();
    expect(window.localStorage.getItem('vic361_submissions_api_url'))
      .toBe('https://example.up.railway.app');
    expect(window.localStorage.getItem('vic361_submissions_admin_token')).toBe('tok-abc');
  });

  it('renderRow renders submission card with status pill and submitter block', () => {
    const { submissions } = { submissions: window.__vic361Submissions };
    const row = {
      id: 'abc', status: 'pending', source: 'submission',
      submitter_kind: 'organizer', submitter_name: 'Jane', submitter_email: 'j@x.com',
      payload: {
        name: 'Test Event', date: '2026-05-12', time: '7 PM',
        venue: 'Venue A', address: '123 Main', icons: ['music'],
        description: 'Hi', free: true,
        submitter_first_name: 'Jane', submitter_last_name: 'Doe',
        submitter_phone: '(361) 555-0123'
      }
    };
    const html = submissions.renderRow(row);
    expect(html).toContain('Test Event');
    expect(html).toContain('submission-status--pending');
    expect(html).toContain('Organizer');
    expect(html).toContain('Jane');
    expect(html).toContain('j@x.com');
    // New: phone shows up in the submitter block, address shows up in meta.
    expect(html).toContain('(361) 555-0123');
    expect(html).toContain('123 Main');
    // Action buttons
    expect(html).toContain('data-act="approve"');
    expect(html).toContain('data-act="reject"');
    expect(html).toContain('data-act="duplicate"');
    expect(html).toContain('data-act="edit"');
  });

  it('renderRow edit view renders visible labels for every editable field', () => {
    const submissions = window.__vic361Submissions;
    submissions._state.editing.add('abc');
    const row = {
      id: 'abc', status: 'pending', source: 'submission',
      submitter_kind: 'organizer', submitter_name: 'Jane Doe',
      submitter_email: 'j@x.com',
      payload: {
        name: 'Test Event', date: '2026-05-12', time: '7:00 PM', end_time: '10:00 PM',
        venue: 'Venue A', address: '123 Main', url: 'https://example.com',
        description: 'Hi', icons: ['music'], free: true,
        submitter_first_name: 'Jane', submitter_last_name: 'Doe',
        submitter_phone: '(361) 555-0123'
      }
    };
    const html = submissions.renderRow(row);
    // Editing banner so the admin sees what they are editing.
    expect(html).toContain('Editing submission');
    expect(html).toContain('Test Event');
    // Visible <label> per editable field (key thing the user asked for).
    const expectedLabels = [
      'Event name', 'Date', 'Start time', 'End time', 'Venue',
      'Address', 'Link', 'Description',
      'Submitter first name', 'Submitter last name', 'Submitter phone'
    ];
    for (const lbl of expectedLabels) {
      expect(html, `missing label "${lbl}"`).toContain(lbl);
    }
    // Each label should be a <label> element bound to a control via data-edit.
    expect(html).toContain('class="submission-edit__label"');
    // All edit fields are still wired through data-edit attributes the save
    // handler reads from.
    for (const k of [
      'name', 'date', 'time', 'end_time', 'venue', 'address', 'url',
      'description', 'submitter_first_name', 'submitter_last_name',
      'submitter_phone'
    ]) {
      expect(html, `missing data-edit="${k}"`).toContain('data-edit="' + k + '"');
    }
    // End time is prefilled from the payload.
    expect(html).toContain('value="10:00 PM"');
    // The submitter's email (row-level) is editable too, prefilled.
    expect(html).toContain('Submitter email');
    expect(html).toMatch(/<input[^>]*type="email"[^>]*data-edit="submitter_email"[^>]*value="j@x.com"/);
    // The date is a date picker, so a day that doesn't exist can't be typed.
    expect(html).toMatch(/<input[^>]*type="date"[^>]*data-edit="date"/);
    submissions._state.editing.clear();
  });

  it('typed-but-unsaved edits survive another card being opened or the list re-rendering', () => {
    const submissions = window.__vic361Submissions;
    const mk = (id, name) => ({ id, status: 'pending', source: 'submission', submitter_kind: 'organizer',
      submitter_name: 'Jane', submitter_email: 'j@x.com',
      payload: { name, date: '2026-11-12', time: '7:00 PM', venue: 'Venue', address: '1 Main', description: 'Hi', icons: [] } });
    submissions._state.submissions = [mk('a', 'First Event'), mk('b', 'Second Event')];
    submissions._state.editing.add('a');
    submissions.render();
    const cardA = () => document.querySelector('.submission-card[data-id="a"]');
    cardA().querySelector('[data-edit="name"]').value = 'First Event (fixed)';
    cardA().querySelector('[data-edit="description"]').value = 'Typed, not saved.';
    document.querySelector('.submission-card[data-id="b"] button[data-act="edit"]').click();
    expect(cardA().querySelector('[data-edit="name"]').value).toBe('First Event (fixed)');
    expect(cardA().querySelector('[data-edit="description"]').value).toBe('Typed, not saved.');
    submissions.render(); // Refresh, or another card's approve
    expect(cardA().querySelector('[data-edit="name"]').value).toBe('First Event (fixed)');
    // Cancel drops the draft.
    cardA().querySelector('button[data-act="cancel-edit"]').click();
    cardA().querySelector('button[data-act="edit"]').click();
    expect(cardA().querySelector('[data-edit="name"]').value).toBe('First Event');
    submissions._state.editing.clear();
    submissions._state.submissions = [];
  });
});

describe('admin Submissions tab — a rejected edit', () => {
  it('shows the server\'s field errors and marks the fields', async () => {
    const { submissions } = bootDom({ apiBase: 'https://example.up.railway.app', token: 'tok' });
    const row = { id: 'a', status: 'approved', source: 'submission', submitter_kind: 'organizer',
      submitter_name: 'Jane', submitter_email: 'j@x.com',
      payload: { name: 'Fair', date: '2026-11-12', time: '7:00 PM', venue: 'Venue', address: '1 Main', description: 'Hi', icons: [] } };
    submissions._state.submissions = [row];
    submissions._state.editing.add('a');
    submissions.render();
    window.fetch = vi.fn(async () => ({ ok: false, status: 400,
      json: async () => ({ ok: false, errors: { address: 'Address is required.' } }) }));
    const card = document.querySelector('.submission-card[data-id="a"]');
    card.querySelector('[data-edit="address"]').value = '';
    card.querySelector('button[data-act="save"]').click();
    await vi.waitFor(() => expect(window.fetch).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    const err = document.getElementById('submissions-error');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe('Address is required.');
    expect(card.querySelector('[data-edit="address"]').getAttribute('aria-invalid')).toBe('true');
    expect(card.querySelector('[data-edit="name"]').hasAttribute('aria-invalid')).toBe(false);
    submissions._state.editing.clear();
    submissions._state.submissions = [];
  });
});

describe('admin source pills + private stripping', () => {
  let admin;
  beforeEach(() => { admin = bootDom().admin; });

  it('inferSource recognizes explicit _source', () => {
    expect(admin.inferSource({ _source: 'submission' })).toBe('submission');
    expect(admin.inferSource({ _source: 'sonar' })).toBe('sonar');
  });

  it('inferSource falls back to URL heuristics for legacy events', () => {
    expect(admin.inferSource({ url: 'https://www.facebook.com/events/123' })).toBe('facebook');
    expect(admin.inferSource({ url: 'https://www.instagram.com/p/abc' })).toBe('instagram');
    expect(admin.inferSource({ url: 'https://www.eventbrite.com/x' })).toBe('scraper');
    expect(admin.inferSource({ url: '' })).toBe('local');
  });

  it('sourceLabel handles known + unknown keys', () => {
    expect(admin.sourceLabel('submission')).toBe('Submitted');
    expect(admin.sourceLabel('weird')).toBe('weird');
    expect(admin.sourceLabel(undefined)).toBe('Unknown');
  });

  it('stripPrivateFields removes underscore-prefixed + submitter PII', () => {
    const ev = {
      name: 'X', date: '2026-05-12', time: '7 PM', venue: 'V',
      _source: 'submission',
      _source_id: 'abc-123',
      _submitter_kind: 'organizer',
      submitter_name: 'Jane',
      submitter_email: 'j@x.com',
      submitter_ip: '1.2.3.4',
      submitter_first_name: 'Jane',
      submitter_last_name: 'Doe',
      submitter_phone: '(361) 555-0123',
      submitter_kind: 'organizer',
      admin_notes: 'private',
      review_history: [{ at: 't' }]
    };
    const out = admin.stripPrivateFields(ev);
    expect(out.name).toBe('X');
    expect(out._source).toBeUndefined();
    expect(out._source_id).toBeUndefined();
    expect(out._submitter_kind).toBeUndefined();
    expect(out.submitter_name).toBeUndefined();
    expect(out.submitter_email).toBeUndefined();
    expect(out.submitter_ip).toBeUndefined();
    expect(out.submitter_first_name).toBeUndefined();
    expect(out.submitter_last_name).toBeUndefined();
    expect(out.submitter_phone).toBeUndefined();
    expect(out.submitter_kind).toBeUndefined();
    expect(out.admin_notes).toBeUndefined();
    expect(out.review_history).toBeUndefined();
    // _source preserved as public `source` for attribution.
    expect(out.source).toBe('submission');
  });

  it('buildEventsPayload strips private fields from selected picks', () => {
    admin._state.candidates = [{
      date: '2026-05-12', name: 'Test', venue: 'V', time: '7 PM',
      end_time: '10 PM', address: '123 Main',
      _source: 'submission', _submitter_kind: 'organizer',
      submitter_email: 'j@x.com', submitter_name: 'Jane',
      submitter_first_name: 'Jane', submitter_last_name: 'Doe',
      submitter_phone: '(361) 555-0123', submitter_kind: 'organizer'
    }];
    admin._state.selected = new Set([admin.eventKey(admin._state.candidates[0])]);
    const payload = admin.buildEventsPayload();
    expect(payload.events.length).toBe(1);
    const ev = payload.events[0];
    expect(ev.submitter_email).toBeUndefined();
    expect(ev.submitter_name).toBeUndefined();
    expect(ev._submitter_kind).toBeUndefined();
    expect(ev.submitter_first_name).toBeUndefined();
    expect(ev.submitter_last_name).toBeUndefined();
    expect(ev.submitter_phone).toBeUndefined();
    expect(ev.submitter_kind).toBeUndefined();
    // Public event fields routed through.
    expect(ev.end_time).toBe('10 PM');
    expect(ev.address).toBe('123 Main');
    expect(ev.source).toBe('submission');
  });

  it('mergeCandidateEvents adds new events but skips dupes by key', () => {
    admin._state.candidates = [
      { date: '2026-05-12', name: 'Existing', venue: 'V' }
    ];
    const added1 = admin.mergeCandidateEvents([
      { date: '2026-05-12', name: 'Existing', venue: 'V' }, // dup
      { date: '2026-05-13', name: 'New', venue: 'V', _source: 'submission' }
    ]);
    expect(added1).toBe(1);
    expect(admin._state.candidates.length).toBe(2);
    const added2 = admin.mergeCandidateEvents([]);
    expect(added2).toBe(0);
  });
});
