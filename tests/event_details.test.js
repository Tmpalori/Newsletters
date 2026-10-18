// @vitest-environment node
//
// Event pages show everything the source said (`details`), while lists and
// the newsletter keep the short description; addresses always read
// "street, City, ST" (no ZIP, no country), wherever they're shown.

import { describe, it, expect } from 'vitest';
import * as seo from '../server/seo.js';
import * as guides from '../server/guides.js';
import { validateEventEdit } from '../server/validate.js';
import { applyCleanup } from '../server/submissionReview.js';

const SITE = 'https://www.thevic361.com';
const NOW = new Date('2026-10-07T17:00:00Z');

describe('fullAddress', () => {
  const f = seo.fullAddress;
  it('adds the town and state to a bare street', () => {
    expect(f('2107 Cloyd Blvd')).toBe('2107 Cloyd Blvd, Victoria, TX');
    expect(f('207 Seville Street Ste C')).toBe('207 Seville Street Ste C, Victoria, TX');
    expect(f('1 Main St', { town: 'Cuero' })).toBe('1 Main St, Cuero, TX');
  });
  it('keeps a stated city, adds its state, drops ZIP and country', () => {
    expect(f('16402 County Road 2, Florence')).toBe('16402 County Road 2, Florence, TX');
    expect(f('16402 County Road 2, Florence, Alabama, 35633')).toBe('16402 County Road 2, Florence, AL');
    expect(f('224 E Mobile St, Florence, AL, United States, Alabama 35630')).toBe('224 E Mobile St, Florence, AL');
    expect(f('114 Plum St, Florence, AL 35630')).toBe('114 Plum St, Florence, AL');
    expect(f('114 Plum St, Florence AL')).toBe('114 Plum St, Florence, AL');
    expect(f('203 E. Constitution St, Victoria, TX 77901')).toBe('203 E. Constitution St, Victoria, TX');
  });
  it('treats a suite part as street, not a city', () => {
    expect(f('207 Seville St, Ste C')).toBe('207 Seville St, Ste C, Victoria, TX');
  });
  it('leaves a place name alone', () => {
    expect(f('Riverside Park')).toBe('Riverside Park');
    expect(f('')).toBe('');
  });
  it('shows in the place line, and the event page names the town once', () => {
    const ev = seo.withPages([{ date: '2026-10-09', name: 'Fall Festival', time: '3:00 PM', venue: '', address: '224 E Mobile St' }])[0];
    expect(seo.placeText(ev)).toBe('224 E Mobile St, Victoria, TX');
    const page = seo.renderEventPage(ev, [ev], { siteUrl: SITE, now: NOW });
    expect(page).toContain('at 224 E Mobile St, Victoria, TX.');
    expect(page).not.toMatch(/Victoria, TX in Victoria/);
    expect(guides.renderIcs(ev, { siteUrl: SITE, now: NOW })).toContain('LOCATION:224 E Mobile St\\, Victoria\\, TX\r');
    expect(new URL(guides.googleCalendarUrl(ev, SITE)).searchParams.get('location')).toBe('224 E Mobile St, Victoria, TX');
  });
});

describe('event page details', () => {
  const base = { date: '2026-10-09', name: 'Fall Festival', time: '3:00 PM', venue: 'First Presbyterian', address: '' };
  it('shows the details, line breaks kept and escaped', () => {
    const ev = seo.withPages([{ ...base, description: 'Pumpkin painting and games.',
      details: 'Pumpkin painting, games and a costume parade.\nParade: 4 PM\nArmbands: $5 <cash only>\n\nHosted by the church youth group.' }])[0];
    const page = seo.renderEventPage(ev, [ev], { siteUrl: SITE, now: NOW });
    expect(page).toContain('<p class="event-about">Pumpkin painting, games and a costume parade.<br>Parade: 4 PM<br>Armbands: $5 &lt;cash only&gt;</p>');
    expect(page).toContain('<p class="event-about">Hosted by the church youth group.</p>');
    // Lists and the meta description stay short.
    expect(page).toContain('<meta name="description" content="Pumpkin painting and games.');
    expect(seo.renderEventItem(ev)).not.toContain('Hosted by');
    expect(guides.renderIcs(ev, { siteUrl: SITE, now: NOW })).toContain('Hosted by');
  });
  it('falls back to the description', () => {
    const ev = seo.withPages([{ ...base, description: 'Pumpkin painting and games.' }])[0];
    expect(seo.renderEventPage(ev, [ev], { siteUrl: SITE, now: NOW })).toContain('<p class="event-about">Pumpkin painting and games.</p>');
  });
});

describe('details in edits and submissions', () => {
  const edit = { name: 'Fall Festival', date: '2026-10-18', time: '3:00 PM', venue: 'Church', description: 'Short.' };
  it('the admin edit keeps line breaks and caps the length', () => {
    const v = validateEventEdit({ ...edit, details: '  Line one \r\nLine two\n\n\n\nLast  ' });
    expect(v.ok).toBe(true);
    expect(v.data.details).toBe('Line one\nLine two\n\nLast');
    expect(validateEventEdit({ ...edit, details: 'x'.repeat(5000) }).data.details).toHaveLength(4000);
    expect(validateEventEdit(edit).data.details).toBe('');
  });
  it("a shortened submission keeps the submitter's text for its page", () => {
    const long = 'Pumpkin painting, games, a costume contest at 4 PM and hot cider. Armbands are $5 at the door; kids under 3 free.';
    const payload = { name: 'Fall Festival', date: '2026-10-10', time: '3:00 PM', end_time: '', venue: 'Church',
      address: '2905 E North St, Victoria, TX', url: '', description: long, icons: ['family'], free: false,
      submitter_first_name: 'Pat', submitter_last_name: 'Doe', submitter_phone: '(361) 555-1234' };
    const out = applyCleanup(payload, { description: 'Pumpkin painting, games and cider for families.' });
    expect(out.payload.description).toBe('Pumpkin painting, games and cider for families.');
    expect(out.payload.details).toBe(long);
    expect(applyCleanup(payload, {}).payload.details).toBeUndefined();
  });
});
