// What each issue shows (server/newsletter.js issueDays/renderWeekly): the
// best-rated events per day in time order, no weekend filler, repeats
// merged into "also Sat & Sun", and a "Don't miss" box at the top.

import { describe, it, expect } from 'vitest';
import { withPages } from '../server/seo.js';
import { renderWeekly, issueDays, isFiller, dontMiss } from '../server/newsletter.js';

const THU = new Date('2026-10-08T12:30:00Z');
const WEEKEND = ['2026-10-09', '2026-10-10', '2026-10-11'];
const opts = { siteUrl: 'https://www.thevic361.com', now: THU, unsubscribeUrl: 'https://www.thevic361.com/unsubscribe?token=t', address: '1 Main', edition: 'weekend' };
const names = day => day.list.map(e => e.name);

describe('filler', () => {
  it('trainings, meetings and low-rated events are filler; a paid pick never is', () => {
    expect(isFiller({ name: 'CPR Certification Course' })).toBe(true);
    expect(isFiller({ name: 'Chair Yoga' })).toBe(true);
    expect(isFiller({ name: 'Bingo Night', appeal: 2 })).toBe(true);
    expect(isFiller({ name: 'Pumpkin Patch', appeal: 4 })).toBe(false);
    expect(isFiller({ name: 'Pumpkin Patch' })).toBe(false);
    expect(isFiller({ name: 'Sales Training', featured: true })).toBe(false);
    expect(isFiller({ name: 'Sales Training', featured: true, editor_pick: true })).toBe(true);
  });

  it('is left out of the weekend issue only', () => {
    const evs = [{ date: '2026-10-09', name: 'Forklift Training', time: '9 AM' }, { date: '2026-10-09', name: 'Corn Maze', time: '5 PM' }];
    expect(names(issueDays(evs, WEEKEND, { weekend: true })[0])).toEqual(['Corn Maze']);
    expect(names(issueDays(evs, WEEKEND)[0])).toEqual(['Forklift Training', 'Corn Maze']);
  });
});

describe('repeats', () => {
  it('a multi-day event shows once, on its first day, with "also Sat & Sun"', () => {
    const evs = WEEKEND.map(date => ({ date, name: 'Turkeyfest', venue: 'Cuero', time: '10 AM' }))
      .concat({ date: '2026-10-10', name: 'Farmers Market', venue: 'Square', time: '8 AM' });
    const days = issueDays(evs, WEEKEND, { weekend: true });
    expect(days.map(d => d.d)).toEqual(['2026-10-09', '2026-10-10']);
    expect(days[0].list[0]).toMatchObject({ name: 'Turkeyfest', also: 'Sat & Sun' });
    expect(names(days[1])).toEqual(['Farmers Market']);
    const issue = renderWeekly(withPages(evs), opts);
    expect(issue.html).toContain('also Sat &amp; Sun');
    expect(issue.text).toContain('Turkeyfest @ Cuero (also Sat & Sun)');
    expect(issue.total).toBe(2);
  });

  it('the same event from two sources on one day shows once', () => {
    const evs = [
      { date: '2026-10-11', name: 'Sunday Jazz Brunch', venue: 'Cafe', time: '11 AM' },
      { date: '2026-10-11', name: 'The Sunday Jazz Brunch at Cafe', venue: 'Cafe', time: '11 AM' },
      { date: '2026-10-11', name: 'Art Walk', venue: 'Downtown', time: '1 PM' }
    ];
    expect(names(issueDays(evs, WEEKEND)[0])).toEqual(['Sunday Jazz Brunch', 'Art Walk']);
  });

  it('a paid Vic’s Pick keeps its own day (it was sold for that day)', () => {
    const evs = [
      { date: '2026-10-09', name: 'Haunted House', venue: 'Barn', time: '7 PM' },
      { date: '2026-10-10', name: 'Haunted House', venue: 'Barn', time: '7 PM', featured: true, sponsor_order: 'o1' }
    ];
    const days = issueDays(evs, WEEKEND, { weekend: true });
    expect(names(days[0])).toEqual(['Haunted House']);
    expect(names(days[1])).toEqual(['Haunted House']);
    expect(renderWeekly(withPages(evs), opts).picks).toEqual(['o1']);
  });
});

describe('which events and in what order', () => {
  // Eight on Saturday: the best six are shown, earliest first.
  const SAT = [
    ['Early Run', '7 AM', 4], ['Pumpkin Patch', '9 AM', 5], ['Library Story Time', '10 AM', 3],
    ['Craft Fair', '11 AM', 4], ['Car Show', '12 PM', 4], ['Concert in the Park', '6 PM', 5],
    ['Bingo', '7 PM', 1], ['Karaoke', '9 PM', 3]
  ].map(([name, time, appeal]) => ({ date: '2026-10-10', name, time, appeal, venue: 'V' }));

  it('shows the best-rated six (picks always), in time order', () => {
    const evs = [...SAT, { date: '2026-10-10', name: 'Sponsor Night', time: '8 PM', appeal: 1, venue: 'V', featured: true, sponsor_order: 'o2' }];
    const issue = renderWeekly(withPages(evs), { ...opts, edition: 'weekly', now: new Date('2026-10-05T12:30:00Z') });
    const sat = issue.text.split('SATURDAY, OCTOBER 10')[1].split('\n\n')[0].split('\n').filter(Boolean).map(l => l.replace(/^- /, '').split(' @ ')[0]);
    expect(sat).toEqual(['7 AM Early Run', '9 AM Pumpkin Patch', '11 AM Craft Fair', '12 PM Car Show', '6 PM Concert in the Park', '8 PM Sponsor Night']);
    expect(issue.picks).toEqual(['o2']);
  });

  it('“Don’t miss” is the issue’s three best, in the HTML, text and preheader', () => {
    const issue = renderWeekly(withPages(SAT), opts);
    expect(dontMiss(issueDays(SAT, WEEKEND, { weekend: true })).map(e => e.name)).toEqual(['Pumpkin Patch', 'Concert in the Park', 'Early Run']);
    expect(issue.html).toContain('Don’t miss this weekend');
    expect(issue.html).toContain('Pumpkin Patch · Concert in the Park · Early Run');
    expect(issue.text).toContain('DON\'T MISS THIS WEEKEND\n1. Pumpkin Patch (Sat 9 AM, V)');
    // Filler (Bingo, rated 1) isn't in the weekend count.
    expect(issue.total).toBe(7);
  });

  it('a small issue skips the box', () => {
    const issue = renderWeekly(withPages(SAT.slice(1, 4)), opts);
    expect(issue.html).not.toContain('Don’t miss');
    expect(issue.text).not.toContain('DON\'T MISS');
  });
});

describe('layout', () => {
  const evs = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name, i) => ({ date: '2026-10-10', name, time: `${i + 8} AM`, venue: 'V', appeal: 4, ...(i === 1 || i === 2 ? { featured: true, sponsor_order: 'o' + i } : {}) }));
  const html = renderWeekly(withPages(evs), opts).html;

  it('Vic’s Picks get space around them and no dashed line above', () => {
    const rowStyle = name => [...html.matchAll(/<tr><td style="([^"]*)">((?:(?!<tr>)[^])*?)>([A-H])<\/a>/g)].find(m => m[3] === name)[1];
    expect(rowStyle('A')).not.toContain('dashed');
    expect(rowStyle('D')).toContain('dashed');
    expect(html.match(/<tr><td style="padding:6px 0;"><table/g)).toHaveLength(2);
  });

  it('"+N more" is a pill in the day’s color, not a plain link', () => {
    const pill = html.match(/<a [^>]*>\+2 more on Saturday →<\/a>/)[0];
    expect(pill).toContain('border-radius:999px');
    expect(pill).toMatch(/#B9A6FF/i); // Saturday's color, as on its header
  });

  it('the welcome email gets the same pill and pick spacing', async () => {
    const { renderWelcomeEmail } = await import('../server/newsletter.js');
    const soon = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name, i) => ({ date: '2026-10-09', name, time: `${i + 8} AM`, venue: 'V', ...(i === 1 ? { featured: true, sponsor_order: 'o1' } : {}) }));
    const w = renderWelcomeEmail(withPages(soon), { siteUrl: 'https://www.thevic361.com', now: THU, unsubscribeUrl: 'x', address: '1 Main' }).html;
    expect(w).toMatch(/<a [^>]*border-radius:999px[^>]*>\+\d+ more this week →<\/a>/);
    expect(w).toContain('<tr><td style="padding:6px 0;"><table');
  });
});

describe('the same as the site', () => {
  const MON = new Date('2026-10-05T12:30:00Z');
  const weekly = { ...opts, edition: 'weekly', now: MON };

  it('times are formatted like the site, and "Don’t miss" gets AM/PM from a shared range', async () => {
    const { formatTime } = await import('../server/seo.js');
    const evs = [
      { date: '2026-10-09', name: 'Fair', time: '4-10 p.m.', venue: 'Grounds', appeal: 5 },
      { date: '2026-10-09', name: 'Run', time: '07:30 AM', venue: 'Park', appeal: 5 },
      { date: '2026-10-10', name: 'Jazz', time: '8:00PM', venue: 'Club', appeal: 5 },
      ...['a', 'b', 'c'].map(n => ({ date: '2026-10-10', name: n, time: '1 PM', venue: 'V', appeal: 3 }))
    ];
    const issue = renderWeekly(withPages(evs), weekly);
    expect(formatTime('4-10 p.m.')).toBe('4 – 10 PM');
    expect(issue.html).toContain('>4 – 10 PM</span>');
    expect(issue.html).toContain('>7:30 AM</span>');
    expect(issue.html).not.toContain('07:30');
    expect(issue.text).toContain('- 8:00 PM Jazz @ Club');
    expect(issue.text).toMatch(/Fair \(Fri 4 PM, Grounds\)/);
  });

  it('free: true is the Free icon on the site and in the email, never left out of the three', async () => {
    const { renderEventItem } = await import('../server/seo.js');
    const ev = { date: '2026-10-09', name: 'Picnic', time: '1 PM', venue: 'Park', page: '/events/x', icons: ['food', 'music', 'family'], free: true };
    expect(renderEventItem(ev)).toContain('#i-free');
    const html = renderWeekly(withPages([ev]), weekly).html;
    expect(html).toContain('/email/free.png');
    expect(html).not.toContain('· Free');
    expect(html.match(/\/email\/(food|music|family|drinks|arts|shopping|outdoors|community|free)\.png/g)).toEqual(['/email/food.png', '/email/music.png', '/email/free.png']);
  });

  it('place line and "Nearby" town like the site', () => {
    const evs = [
      { date: '2026-10-09', name: 'Turkeyfest', time: '10 AM', venue: 'Fairgrounds', address: '1 Main St', town: 'Cuero' },
      { date: '2026-10-09', name: 'Yard Sale', time: '8 AM', address: '200 Oak St' }
    ];
    const issue = renderWeekly(withPages(evs), weekly);
    expect(issue.html).toContain('Nearby · Cuero');
    expect(issue.html).toContain('· Fairgrounds · 1 Main St, Cuero, TX');
    expect(issue.html).toContain('· 200 Oak St, Victoria, TX');
    expect(issue.text).toContain('Turkeyfest @ Fairgrounds · 1 Main St, Cuero, TX (Cuero)');
  });

  it('the weekly "+N more" opens that day on the homepage', () => {
    const evs = Array.from({ length: 8 }, (_, i) => ({ date: '2026-10-09', name: `E${i}`, time: `${i + 8} AM`, venue: 'V', appeal: 4 }));
    const html = renderWeekly(withPages(evs), weekly).html;
    expect(html).toMatch(/href="https:\/\/www\.thevic361\.com\/\?utm_[^"]*#day-4"[^>]*>\+2 more on Friday/);
  });

  it('a hub page colors a day by its weekday, not its position', async () => {
    const { renderGrouped } = await import('../server/seo.js');
    const html = renderGrouped([{ date: '2026-10-09', name: 'A', page: '/events/a' }, { date: '2026-10-10', name: 'B', page: '/events/b' }], '2026-10-09');
    expect(html).toContain('class="day-section day--d4" id="day-0"');
    expect(html).toContain('class="day-section day--d5" id="day-1"');
  });

  it('the welcome email dates days past this Sunday', async () => {
    const { renderWelcomeEmail } = await import('../server/newsletter.js');
    const FRI = new Date('2026-10-09T15:00:00Z');
    const w = renderWelcomeEmail(withPages([
      { date: '2026-10-13', name: 'Tuesday Pick', time: '6 PM', venue: 'V', featured: true },
      { date: '2026-10-09', name: 'Tonight', time: '7 PM', venue: 'V' }
    ]), { siteUrl: 'https://www.thevic361.com', now: FRI, unsubscribeUrl: 'x', address: '1 Main' });
    expect(w.text).toContain('- Today 7 PM: Tonight');
    expect(w.text).toContain('- Tue, Oct 13 6 PM: Tuesday Pick');
    expect(w.text.indexOf('Tonight')).toBeLessThan(w.text.indexOf('Tuesday Pick'));
  });
});
