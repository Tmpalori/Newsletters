// @vitest-environment node
//
// Where a business finds the sponsor and Vic's Pick offers: the house ad in
// an unsold week's sponsor slot (site and newsletter), the "Give it the Vic's
// Pick badge" line under days with spots left, and the menu link.

import { describe, it, expect } from 'vitest';
import { sponsorHtml, houseAdHtml, pickPromptHtml, navHtml, renderDays, withPages } from '../server/seo.js';
import { renderWeekly } from '../server/newsletter.js';

const SITE = 'https://www.thevic361.com';
const today = '2026-10-07'; // Wednesday
const ev = (date, extra = {}) => ({ name: `Event ${date}`, date, time: '7:00 PM', venue: 'Somewhere', ...extra });
const paid = date => ev(date, { featured: true });
const sponsor = { name: 'Acme Tacos', text: 'Best tacos in town.', cta: 'Order now', url: 'https://acme.example' };

describe('house ad in the sponsor slot', () => {
  it('fills an unsold week and gives way to a paid sponsor', () => {
    expect(sponsorHtml(null)).toBe(houseAdHtml());
    expect(houseAdHtml()).toContain('href="/advertise"');
    expect(houseAdHtml()).not.toContain('$'); // prices stay on the sponsor pages
    const paidBlock = sponsorHtml(sponsor);
    expect(paidBlock).toContain('Acme Tacos');
    expect(paidBlock).not.toContain('sponsor-block--house');
  });

  it('is not counted as a sponsor click', () => {
    expect(houseAdHtml()).not.toContain('sponsor-cta');
  });
});

describe('Vic\'s Pick line under a day', () => {
  it('shows on days ahead with spots left, linking checkout to that date', () => {
    const line = pickPromptHtml('2026-10-09', [ev('2026-10-09')], today);
    expect(line).toContain('Have an event Friday?');
    expect(line).toContain('/advertise/checkout?package=featured&amp;date=2026-10-09');
    expect(line).toContain('Give it the Vic’s Pick badge');
    expect(line).not.toContain('$');
  });

  it('skips today and past days', () => {
    expect(pickPromptHtml(today, [], today)).toBe('');
    expect(pickPromptHtml('2026-10-05', [], today)).toBe('');
  });

  it('skips a day whose paid picks are sold out, but not for editor\'s picks', () => {
    const thu = '2026-10-08'; // weekday cap 3
    expect(pickPromptHtml(thu, [paid(thu), paid(thu), paid(thu)], today)).toBe('');
    expect(pickPromptHtml(thu, [paid(thu), paid(thu), ev(thu, { featured: true, editor_pick: true })], today)).not.toBe('');
  });

  it('is drawn into the homepage week', () => {
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const html = renderDays(week, withPages([ev('2026-10-08')]), today);
    expect((html.match(/class="pick-prompt"/g) || []).length).toBe(4); // Thu–Sun
  });
});

describe('menu link', () => {
  it('is on every page and marks the advertise page', () => {
    expect(navHtml('/')).toContain('<a class="browse-biz" href="/advertise">Feature your business</a>');
    expect(navHtml('/advertise')).toContain('href="/advertise" aria-current="page"');
  });
});

describe('newsletter', () => {
  const opts = { siteUrl: SITE, now: new Date('2026-10-05T12:43:00Z'), unsubscribeUrl: 'u', address: 'a' };
  const events = withPages([ev('2026-10-06'), ev('2026-10-08')]);

  it('an unsold week carries the house ad under the list', () => {
    const issue = renderWeekly(events, { ...opts, sponsor: null });
    expect(issue.html).toContain('YOUR BUSINESS HERE');
    expect(issue.html.indexOf('YOUR BUSINESS HERE')).toBeGreaterThan(issue.html.indexOf('See the full list'));
    expect(issue.text).toContain('FEATURE YOUR BUSINESS');
    expect(issue.html.slice(issue.html.indexOf('YOUR BUSINESS HERE'))).not.toMatch(/\$\d/);
    expect(issue.text).not.toMatch(/FEATURE YOUR BUSINESS[^\n]*\$\d/);
  });

  it('a sponsored week has no house ad', () => {
    const issue = renderWeekly(events, { ...opts, sponsor });
    expect(issue.html).not.toContain('YOUR BUSINESS HERE');
    expect(issue.text).not.toContain('FEATURE YOUR BUSINESS');
  });
});
