// @vitest-environment node
//
// A town's money and limits (town.business, MULTI_CITY_PLAN.md 1.2f): what
// Stripe charges, the price text on pages and emails (generated from the
// amounts, so the two can't drift), pick caps, curation limits and the
// referral tiers. Victoria's output is pinned by tests/golden/.

import { describe, it, expect, afterAll } from 'vitest';
import { townConfig, useTown, VICTORIA, dollars } from '../server/town.js';
import { AD_PACKAGES, advertiseStats, renderAdvertisePage } from '../server/seo.js';
import { VICS_PICK, pickPackage } from '../server/sponsors.js';
import { DAY_MAX, PICKS, PICKS_MIN } from '../server/scoring.js';
import { referralTiers } from '../server/referralRewards.js';
import { renderReferralRules } from '../server/newsletter.js';
import { renderSubmissionReceived } from '../server/notify.js';

const BAY = {
  id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago',
  business: { weeklyAmount: 20000, pickAmount: { weekday: 2950, weekend: 5900 }, pickCap: { weekday: 2, weekend: 3 }, drawingAmount: 50,
    rewardCards: [{ n: 3, amount: 5 }] }
};

afterAll(() => useTown(VICTORIA));

it('dollars() drops .00 and keeps real cents', () => {
  expect(dollars(4900)).toBe('$49');
  expect(dollars(30000)).toBe('$300');
  expect(dollars(2950)).toBe('$29.50');
});

describe('Victoria', () => {
  it('keeps today’s numbers', () => {
    useTown(VICTORIA);
    expect(AD_PACKAGES.map(p => [p.key, p.amount, p.price])).toEqual([
      ['weekly', 14900, '$149 / week'], ['featured', 2900, '$29 Mon–Thu · $39 Fri–Sun'], ['category', 9900, '$99 / month']]);
    expect(AD_PACKAGES[1].limit).toBe('Only 3 a day Mon–Thu and 4 a day Fri–Sun, so book early.');
    expect({ ...VICS_PICK }).toEqual({ weekdayAmount: 2900, weekendAmount: 3900, weekdayCap: 3, weekendCap: 4 });
    expect([{ ...DAY_MAX }, { ...PICKS }, { ...PICKS_MIN }]).toEqual([{ weekday: 15, weekend: 20 }, { weekday: 2, weekend: 3 }, { weekday: 1, weekend: 2 }]);
    expect(referralTiers().map(t => [t.n, t.amount || 0, t.reward])).toEqual([
      [1, 0, 'an entry in our monthly $25 gift card drawing'], [5, 10, 'a $10 gift card'], [10, 25, 'a $25 gift card']]);
  });
});

describe('another town', () => {
  it('charges and shows its own prices', () => {
    useTown(townConfig({}, { town: BAY }));
    expect(AD_PACKAGES.map(p => [p.key, p.amount, p.price])).toEqual([
      ['weekly', 20000, '$200 / week'], ['featured', 2950, '$29.50 Mon–Thu · $59 Fri–Sun'], ['category', 9900, '$99 / month']]);
    expect(AD_PACKAGES[1].limit).toBe('Only 2 a day Mon–Thu and 3 a day Fri–Sun, so book early.');
    expect(pickPackage('2026-10-07').amount).toBe(2950);   // Wednesday
    expect(pickPackage('2026-10-10')).toMatchObject({ key: 'featured_weekend', amount: 5900 });
    expect([VICS_PICK.weekdayCap, VICS_PICK.weekendCap]).toEqual([2, 3]);
    const page = renderAdvertisePage({ siteUrl: 'https://www.thebay979.com', now: new Date('2026-10-07T17:00:00Z'), stats: advertiseStats([], new Date('2026-10-07T17:00:00Z')) });
    expect(page).toContain('$200 / week');
    expect(page).toContain('$29.50 Mon–Thu · $59 Fri–Sun');
    expect(page).not.toMatch(/\$149\b|\$29(?!\.50)\b|\$39\b/);
    const email = renderSubmissionReceived({ name: 'Fish Fry', date: '2026-10-09', time: '6:00 PM', venue: 'Hall' },
      { siteUrl: 'https://www.thebay979.com', address: '', upgradeUrl: 'https://www.thebay979.com/up' });
    // The free-submission email carries no paid upsell (and so no prices).
    expect(email.html).not.toMatch(/\$29|\$59|\$39|\$149/);
  });

  it('keeps the shared curation defaults it doesn’t set', () => {
    useTown(townConfig({}, { town: BAY }));
    expect({ ...DAY_MAX }).toEqual({ weekday: 15, weekend: 20 });
    expect({ ...PICKS }).toEqual({ weekday: 2, weekend: 3 });
  });

  it('has its own referral drawing and gift cards', () => {
    useTown(townConfig({}, { town: BAY }));
    expect(referralTiers().map(t => [t.n, t.amount || 0, t.reward])).toEqual([
      [1, 0, 'an entry in our monthly $50 gift card drawing'], [3, 5, 'a $5 gift card']]);
    const rules = renderReferralRules({ siteUrl: 'https://www.thebay979.com' });
    expect(rules).toContain('gets a $50 digital gift card');
    expect(rules).not.toContain('$25');
  });

  it('refuses numbers that would break checkout', () => {
    const bad = business => () => townConfig({}, { town: { ...BAY, business: { ...BAY.business, ...business } } });
    expect(bad({ weeklyAmount: 49.5 })).toThrow(/whole cents/);
    expect(bad({ pickAmount: { weekday: 50 } })).toThrow(/whole cents/);
    expect(bad({ pickCap: { weekday: 2 } })).toThrow(/caps/);
    expect(bad({ rewardCards: 'none' })).toThrow(/rewardCards/);
  });
});
