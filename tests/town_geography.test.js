// @vitest-environment node
//
// A town's geography (server/town.js city, state, cityState): event pages,
// schema.org, calendar files, venue pages, address cleanup and email
// footers name the site's own town, never Victoria. (Victoria's output is
// pinned by tests/golden/.) Hub pages and seasonal guides are page copy
// and move in MULTI_CITY_PLAN.md 1.2d.

import { describe, it, expect, afterAll } from 'vitest';
import { townConfig, useTown, VICTORIA } from '../server/town.js';
import { townOf, eventJsonLd, renderEventPage, withPages } from '../server/seo.js';
import { renderIcs, googleCalendarUrl, streetAddress, renderVenuePage, renderVenueIndex, buildVenues } from '../server/guides.js';
import { renderConfirmEmail } from '../server/newsletter.js';
import { renderSponsorConfirmed } from '../server/notify.js';

const SITE = 'https://www.thebay979.com';
const NOW = new Date('2026-10-07T17:00:00Z');
const BAY = { siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const OK = { siteName: 'Tulsa Today', domain: 'tulsatoday.com', city: 'Tulsa', state: 'OK', stateName: 'Oklahoma', timezone: 'America/Chicago' };
const [ev] = withPages([{ date: '2026-10-09', name: 'Fish Fry', venue: 'Hall', address: '10 Main St', time: '6:00 PM' }]);
// The place label. A bare "Victoria" in sentences ("Get Victoria's best
// events…") is page copy, which moves in 1.2d.
const victoria = s => /Victoria, (TX|Texas)/.test(String(s));

afterAll(() => useTown(VICTORIA));

describe('Victoria', () => {
  it('keeps its place names', () => {
    useTown(VICTORIA);
    expect(VICTORIA).toMatchObject({ city: 'Victoria', state: 'TX', cityState: 'Victoria, TX', cityStateLong: 'Victoria, Texas' });
    expect(townOf({})).toBe('Victoria');
    expect(townOf({ town: 'Cuero' })).toBe('Cuero');
    expect(eventJsonLd(ev, SITE).location.address).toMatchObject({ addressLocality: 'Victoria', addressRegion: 'TX' });
    expect(streetAddress('203 E. Constitution St, Victoria, TX 77901')).toBe('203 E. Constitution St');
    expect(streetAddress('123 N Victoria')).toBe('123 N Victoria'); // a street, not the city
  });
});

describe('another town', () => {
  it('derives its place labels from its own city and state', () => {
    expect(townConfig({}, { town: OK })).toMatchObject({ cityState: 'Tulsa, OK', cityStateLong: 'Tulsa, Oklahoma' });
    expect(() => townConfig({}, { town: { ...OK, cityState: 'Tulsa <b>' } })).toThrow(/cityState can't/);
  });

  it('event pages, schema.org, calendar files and the calendar link name it', () => {
    useTown(townConfig({}, { town: OK }));
    expect(townOf({})).toBe('Tulsa');
    expect(townOf({ town: 'Broken Arrow' })).toBe('Broken Arrow');
    const ld = eventJsonLd(ev, SITE);
    expect(ld.location.address).toMatchObject({ addressLocality: 'Tulsa', addressRegion: 'OK', addressCountry: 'US' });
    expect(eventJsonLd({ ...ev, venue: '' }, SITE).location.name).toBe('Tulsa, OK');
    const page = renderEventPage(ev, [ev], { siteUrl: SITE, now: NOW });
    expect(page).toContain('at Hall, 10 Main St, Tulsa, OK.');
    expect(page).not.toMatch(/, TX\b/);
    expect(renderIcs(ev, { siteUrl: SITE, now: NOW })).toMatch(/LOCATION:.*Tulsa\\, OK/);
    expect(new URL(googleCalendarUrl(ev, SITE)).searchParams.get('location')).toBe('Hall, 10 Main St, Tulsa, OK');
  });

  it('strips its own city from addresses, not Victoria', () => {
    useTown(townConfig({}, { town: BAY }));
    expect(streetAddress('9 Ave F, Bay City, TX 77414')).toBe('9 Ave F');
    expect(streetAddress('9 Ave F Bay City Texas')).toBe('9 Ave F');
    expect(streetAddress('9 Ave F, Victoria, TX')).toBe('9 Ave F, Victoria, TX');
    expect(streetAddress('2 Bay City Rd')).toBe('2 Bay City Rd');
  });

  it('venue pages and email footers name it', () => {
    useTown(townConfig({}, { town: BAY }));
    const [venue] = buildVenues([{ name: 'Hall', category: 'Event space' }]);
    const live = [{ ...ev, venue: 'Hall', address: '9 Ave F, Bay City, TX' }];
    const vpage = renderVenuePage(venue, live, [], { siteUrl: SITE, now: NOW, venues: [venue] });
    expect(vpage).toContain('9 Ave F, Bay City, TX</dd>');
    expect(vpage).toContain('"addressLocality":"Bay City"');
    expect(victoria(vpage)).toBe(false);
    expect(victoria(renderVenueIndex([venue], live, [], { siteUrl: SITE, now: NOW }))).toBe(false);
    const confirm = renderConfirmEmail({ siteUrl: SITE, confirmUrl: SITE + '/c', address: '' });
    expect(confirm.html).toContain('Bay City, TX');
    expect(victoria(confirm.html + confirm.text)).toBe(false);
    const order = { id: 'o1', kind: 'weekly', status: 'paid', amount: 30000, week_start: '2026-10-12', business: 'Acme', email: 'a@b.example',
      sponsor: { name: 'Acme', text: 'Hi.', cta: 'Go', url: 'https://acme.example' } };
    const booked = renderSponsorConfirmed(order, { siteUrl: SITE, address: '' });
    expect(booked.html).toContain('Bay City, TX');
    expect(victoria(booked.html + booked.text)).toBe(false);
  });
});
