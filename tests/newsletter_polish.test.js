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

  it('two names for one event at one address show once, the hand-entered one, in "Don’t miss" too', () => {
    // Shoals, 2026-10-19 issue: "Don't miss" #2 and #3 were this pair.
    const evs = [
      { date: '2026-10-10', name: 'Alabama Renaissance Faire (Florence, AL) Free Admission & Parking and Family-Friendly for 40 Faires!',
        venue: '', address: '217 E Tuscaloosa St', time: '10:00 AM', appeal: 5, editor_pick: true },
      { date: '2026-10-10', name: '40th Alabama Renaissance Faire', venue: 'Wilson Park', address: '217 E Tuscaloosa St, Florence',
        time: 'All day', appeal: 5, editor_pick: true, curated: true },
      { date: '2026-10-11', name: '40th Alabama Renaissance Faire', venue: 'Wilson Park', address: '217 E Tuscaloosa St, Florence',
        time: 'All day', appeal: 4, curated: true },
      { date: '2026-10-10', name: 'Renaissance Painting Class', venue: 'Art Barn', address: '217 E Tuscaloosa St', time: '2 PM', appeal: 4 }
    ];
    const days = issueDays(evs, WEEKEND);
    expect(names(days[0])).toEqual(['40th Alabama Renaissance Faire', 'Renaissance Painting Class']);
    expect(days[0].list[0].also).toBe('Sun');
    expect(dontMiss(days).map(e => e.name)).toEqual(['40th Alabama Renaissance Faire', 'Renaissance Painting Class']);
  });

  it('a bar’s “Live Music at …” drops out when that night’s act there is listed', () => {
    const evs = [
      { date: '2026-10-09', name: 'Live Music at Swampers', venue: 'Swampers Bar & Grille', time: '7:30 PM – 10:00 PM' },
      { date: '2026-10-09', name: 'Preston Watts', venue: 'Swampers Bar & Grille', time: '8:00 PM', icons: ['music'] },
      { date: '2026-10-09', name: 'Karaoke at Rattlesnake Saloon', venue: 'Rattlesnake Saloon', time: '6:00 PM' },
      { date: '2026-10-09', name: 'Karaoke w/ Cole', venue: 'Rattlesnake Saloon', time: '6:00 PM', icons: ['music'] },
      // Hours apart: an early act and a late set are two things.
      { date: '2026-10-09', name: 'Live Music at Champy’s', venue: 'Champy’s', time: '9:00 PM' },
      { date: '2026-10-09', name: 'Happy Hour Duo', venue: 'Champy’s', time: '4:00 PM', icons: ['music'] },
      // Karaoke isn't the band.
      { date: '2026-10-09', name: 'Live Music at FloBama', venue: 'FloBama Music Hall', time: '8:00 PM' },
      { date: '2026-10-09', name: 'Late-Night Karaoke', venue: 'FloBama Music Hall', time: '8:00 PM', icons: ['music'] }
    ];
    expect(names(issueDays(evs, WEEKEND)[0]).sort()).toEqual(['Happy Hour Duo', 'Karaoke w/ Cole', 'Late-Night Karaoke',
      'Live Music at Champy’s', 'Live Music at FloBama', 'Preston Watts']);
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
  // Eight on Saturday: the best four are shown (a weekday shows three), earliest first.
  const SAT = [
    ['Early Run', '7 AM', 4], ['Pumpkin Patch', '9 AM', 5], ['Library Story Time', '10 AM', 3],
    ['Craft Fair', '11 AM', 4], ['Car Show', '12 PM', 4], ['Concert in the Park', '6 PM', 5],
    ['Bingo', '7 PM', 1], ['Karaoke', '9 PM', 3]
  ].map(([name, time, appeal]) => ({ date: '2026-10-10', name, time, appeal, venue: 'V' }));

  it('shows the best-rated four on a weekend day (picks always), in time order', () => {
    const evs = [...SAT, { date: '2026-10-10', name: 'Sponsor Night', time: '8 PM', appeal: 1, venue: 'V', featured: true, sponsor_order: 'o2' }];
    const issue = renderWeekly(withPages(evs), { ...opts, edition: 'weekly', now: new Date('2026-10-05T12:30:00Z') });
    const sat = issue.text.split('SATURDAY, OCTOBER 10')[1].split('\n\n')[0].split('\n').filter(Boolean).map(l => l.replace(/^- /, '').split(' @ ')[0]);
    expect(sat).toEqual(['7 AM Early Run', '9 AM Pumpkin Patch', '6 PM Concert in the Park', '8 PM Sponsor Night']);
    expect(issue.picks).toEqual(['o2']);
  });

  it('shows three on a weekday, with "+N more" to the site for the rest', () => {
    const wed = SAT.map(e => ({ ...e, date: '2026-10-07' }));
    const issue = renderWeekly(withPages(wed), { ...opts, edition: 'weekly', now: new Date('2026-10-05T12:30:00Z') });
    const day = issue.text.split('WEDNESDAY, OCTOBER 7')[1].split('\n\n')[0].split('\n').filter(Boolean);
    expect(day).toHaveLength(3);
    expect(issue.html).toMatch(/\+5 more on Wednesday/);
  });

  it('opens with a greeting and an "In this issue" list: the top 3 (linked bullets), how many more, the sections', () => {
    const issue = renderWeekly(withPages(SAT), opts);
    expect(dontMiss(issueDays(SAT, WEEKEND, { weekend: true })).map(e => e.name)).toEqual(['Pumpkin Patch', 'Concert in the Park', 'Early Run']);
    expect(issue.html).not.toContain('Don’t miss');
    expect(issue.html).toContain('In this issue');
    expect(issue.html).toMatch(/Top 3 events you don’t want to miss this weekend<\/strong><div[^>]*>•&nbsp;<a href="[^"]*\/events\/[^"]*pumpkin-patch[^"]*"[^>]*>Pumpkin Patch<\/a> <span[^>]*>\(Sat\)<\/span><\/div>/);
    expect(issue.html).toContain('Pumpkin Patch · Concert in the Park · Early Run');
    // The rest: everything else on the site for those days (8 in all).
    expect(issue.text).toContain('IN THIS ISSUE\n- Top 3 events you don’t want to miss this weekend\n    • Pumpkin Patch (Sat)\n    • Concert in the Park (Sat)\n    • Early Run (Sat)\n- Plus another 5 things going on this weekend');
    // Readers are told everything on the site for those days (8), though the
    // email leaves filler (Bingo, rated 1) out of its own list (7).
    expect(issue.count).toBe(8);
    expect(issue.total).toBe(7);
    expect(issue.subject).toMatch(/^This weekend in Victoria: 8 things to do/);
  });

  it('lists the sections, and uses the AI’s greeting only when any event it names is in the issue', () => {
    const sections = { pet: { name: 'Chloe' }, places: [{ name: 'Chai' }, { name: 'Bao Bao Bakery' }], question: 'Q?', monday: '2026-10-05',
      poll: { id: 'p', question: 'Have you gone to something you found here?', choices: ['Yes', 'No'] } };
    const plain = renderWeekly(withPages(SAT), { ...opts, sections });
    // The poll and the question by name, cut at a word to fit one line.
    expect(plain.text).toContain('- Meet Chloe, our pet of the week\n- New spots: Chai and Bao Bao Bakery\n- Quick poll: Have you gone to something you found here?\n- Question of the week: Q?');
    const long = renderWeekly(withPages(SAT), { ...opts, sections: { ...sections, question: 'What is the one local spot you always take visiting family and friends to first?' } });
    expect(long.text).toContain('- Question of the week: What is the one local spot you always take visiting…');
    const good = { text: 'Cooler nights and Pumpkin Patch on Saturday: fall is here.', mentions: ['Pumpkin Patch'] };
    const withAi = renderWeekly(withPages(SAT), { ...opts, sections: { ...sections, intro: good } });
    expect(withAi.text).toContain(good.text);
    expect(withAi.html).toContain('Cooler nights and <strong>Pumpkin Patch</strong> on Saturday');
    // Names something the issue doesn't show (hidden by the event check): a plain greeting.
    const stale = { text: 'Bingo Night is the big one.', mentions: ['Bingo Night'] };
    expect(renderWeekly(withPages(SAT), { ...opts, sections: { ...sections, intro: stale } }).text).not.toContain('Bingo Night is the big one');
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
    // Four on a Saturday: E (its "12 AM" sorts first), A, then the picks B and C.
    expect(rowStyle('A')).not.toContain('dashed');
    expect(rowStyle('E')).toContain('dashed');
    expect(html.match(/<tr><td style="padding:6px 0;"><table/g)).toHaveLength(2);
  });

  it('"+N more" is a pill in the day’s color, not a plain link', () => {
    const pill = html.match(/<a [^>]*>\+4 more on Saturday →<\/a>/)[0];
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

  it('times are formatted like the site', async () => {
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
    expect(issue.text).not.toContain('DON\'T MISS');
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
    expect(html).toMatch(/href="https:\/\/www\.thevic361\.com\/\?utm_[^"]*#day-4"[^>]*>\+4 more on Friday/);
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

describe('the multi-agent review (Oct 2026)', () => {
  const MON2 = new Date('2026-10-05T12:30:00Z');
  const base = { siteUrl: 'https://www.thevic361.com', unsubscribeUrl: '#', edition: 'weekly', now: MON2 };
  const day = (name, i, extra = {}) => ({ date: '2026-10-07', name, time: `${8 + i} AM`, venue: `Place ${i}`, ...extra });

  it('always shows a paid pick, even past the day’s cap', () => {
    // Four paid picks on a weekday (3 a day): all four run.
    const evs = [0, 1, 2, 3].map(i => day(`Paid Pick ${i}`, i, { featured: true, sponsor_order: `o${i}` })).concat([day('Other', 5, { appeal: 5 })]);
    const issue = renderWeekly(withPages(evs), base);
    for (const i of [0, 1, 2, 3]) expect(issue.html).toContain(`Paid Pick ${i}`);
    expect(issue.picks.length).toBe(4);
  });

  it('uses the plain greeting when the AI names an event the issue doesn’t lead with', () => {
    const evs = [day('Zoo Boo', 0, { appeal: 5 }), day('Haunted Hayride Night', 1, { date: '2026-10-20' })];
    const sections = { intro: { edition: 'weekly', week: '2026-10-05', text: 'Happy Monday! Catch the Haunted Hayride Night soon.', mentions: [] } };
    const issue = renderWeekly(withPages(evs), { ...base, sections });
    expect(issue.html).not.toContain('Haunted Hayride Night soon');
  });

  it('never fails an issue over a malformed sections object', () => {
    const sections = { monday: '2026-10-05', places: [null], pet: { name: 'X' }, roundup: { answers: [null] } };
    expect(() => renderWeekly(withPages([day('Zoo Boo', 0)]), { ...base, sections })).not.toThrow();
  });
});
