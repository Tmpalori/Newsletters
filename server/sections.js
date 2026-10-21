/* server/sections.js — the newsletter's extra sections (SECTIONS.md).
 *
 * Under the events in each issue and on the homepage:
 *   Monday     pet of the week, new in town, the question of the week, and
 *              on the first Monday of the month a one-tap poll
 *   Thursday   the readers' answers to Monday's question, updates from
 *              city hall (good news only, nothing political)
 *
 * What's in them comes from the town's jobs worker (scripts/sections.py,
 * job "sections"), which hands the site a `sections` file after its AI
 * editor read every item. The questions and polls are the town's own list
 * in sections.json (Victoria's at the repo root, another town's in
 * towns/<slug>/). A town without sections.json, or with "enabled": false,
 * shows none of it and every page and email is byte for byte what it was
 * (the Victoria goldens). SECTIONS=1 / SECTIONS=0 overrides the file.
 *
 *   GET  /sections/pet/:id.jpg        this week's pet photo (copied, resized)
 *   GET  /p/:week/:poll/:choice?s=    a poll vote from the email → results
 *   GET  /poll/:week/:poll            the results page
 *   GET  /api/admin/sections          what's in this week's sections
 *   POST /api/admin/sections/hide     { id, hidden } take an item out (or back)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { town } from './town.js';
import { escHtml, safeUrl, localDateStr, addDays, layout } from './seo.js';
import { renderSectionCard } from './ogImage.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The week a question or poll belongs to (scripts/sections.py QUESTION_EPOCH).
const EPOCH = '2026-01-05';
// A sections file older than this isn't shown (the worker stopped).
const STALE_DAYS = 9;
// Mail scanners (Outlook's Safe Links, Mimecast) open every link in an
// email as it arrives: a "vote" for each choice within seconds. A second,
// different choice this soon after the first means a scanner, and the
// vote is thrown out.
const SCANNER_BURST_MS = 30 * 1000;

export function sectionsConfig(t = town, { root = ROOT, env = process.env } = {}) {
  const dir = t.id === 'victoria' ? root : path.join(root, 'towns', t.id);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'sections.json'), 'utf8')); } catch (_) { cfg = {}; }
  const flag = String(env.SECTIONS || '').trim();
  const enabled = flag === '1' ? true : flag === '0' ? false : cfg.enabled === true;
  return { ...cfg, enabled };
}

const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
export const mondayOf = ymd => addDays(ymd, -((new Date(ymd + 'T12:00:00Z').getUTCDay() + 6) % 7));

export function questionFor(cfg, monday) {
  const qs = (cfg.questions || []).filter(q => typeof q === 'string' && q.trim());
  if (!qs.length) return null;
  const i = Math.floor(daysBetween(EPOCH, monday) / 7);
  return qs[((i % qs.length) + qs.length) % qs.length];
}

// The first Monday issue of each month asks one poll, in the list's order.
export function pollFor(cfg, monday) {
  const polls = (cfg.polls || []).filter(p => p && p.id && p.question && Array.isArray(p.choices) && p.choices.length >= 2);
  if (!polls.length || Number(monday.slice(8, 10)) > 7) return null;
  const months = (Number(monday.slice(0, 4)) - 2026) * 12 + Number(monday.slice(5, 7)) - 1;
  return polls[((months % polls.length) + polls.length) % polls.length];
}

/**
 * What an issue (or the homepage) shows: { pet, places, question, poll,
 * roundup, good } with anything the owner took out left out, and nothing
 * from a sections file that isn't this week's.
 */
export function sectionsFor({ cfg, file, hidden = [], edition = 'weekly', now = new Date() }) {
  if (!cfg || !cfg.enabled) return null;
  const today = localDateStr(now);
  const monday = mondayOf(today);
  // Sunday evening's build is already for tomorrow's issue (-1).
  const fresh = file && typeof file.week === 'string' && daysBetween(file.week, today) >= -1 && daysBetween(file.week, today) <= STALE_DAYS;
  const f = fresh ? file : {};
  const off = new Set(hidden);
  const pet = f.pet && f.pet.photo && !off.has('pet') ? f.pet : null;
  const places = (f.new_in_town || []).filter(x => x && x.name && !off.has(`place:${x.key}`));
  const good = f.good_news && Array.isArray(f.good_news.items) && !off.has('good')
    ? { ...f.good_news, items: f.good_news.items.filter((x, i) => !off.has(`good:${i}`)) } : null;
  const roundup = f.roundup && Array.isArray(f.roundup.answers) && !off.has('roundup')
    ? { ...f.roundup, answers: f.roundup.answers.filter((x, i) => !off.has(`reply:${i}`)) } : null;
  const out = { monday, edition };
  // The AI's opening paragraph for this very issue (server/newsletter.js
  // introText checks it names only events the issue shows).
  out.intro = f.intro && f.intro.edition === edition && f.intro.week === (edition === 'weekend' ? addDays(monday, 3) : monday) ? f.intro : null;
  if (edition === 'weekend') {
    out.roundup = roundup && roundup.answers.length >= 2 ? roundup : null;
    out.good = good && good.items.length ? good : null;
  } else {
    out.pet = pet;
    out.places = places;
    // The job's pick (the AI's new questions first), else the town's list.
    out.question = off.has('question') ? null : (f.week === monday && typeof f.question === 'string' && f.question) || questionFor(cfg, monday);
    out.poll = off.has('poll') ? null : pollFor(cfg, monday);
  }
  return out;
}

// The homepage keeps everything from this week at once.
export function homeSections({ cfg, file, hidden = [], now = new Date() }) {
  const a = sectionsFor({ cfg, file, hidden, edition: 'weekly', now });
  if (!a) return null;
  const b = sectionsFor({ cfg, file, hidden, edition: 'weekend', now });
  return { ...a, roundup: b.roundup, good: b.good };
}

// ─── Homepage ───────────────────────────────────────────────────────────
// The site's own classes (docs/style.css: section-heading, notable-list,
// btn) plus a few card rules of its own, inline so the stylesheet (and its
// cache hash in every golden page) doesn't change.
const HOME_CSS = `<style>
.sx-feature{display:grid;grid-template-columns:minmax(0,260px) minmax(0,1fr);grid-template-areas:"photo head" "photo body";column-gap:var(--space-6);align-items:start;margin-block:var(--space-8)}
.sx-feature img{grid-area:photo;width:100%;max-width:260px;aspect-ratio:1;object-fit:cover;border:3px solid var(--color-border);border-radius:var(--radius-xl);box-shadow:6px 6px 0 var(--color-border)}
.sx-feature .sx-head{grid-area:head;align-self:end}
.sx-feature .sx-body{grid-area:body;display:grid;gap:var(--space-3);justify-items:start;margin-top:var(--space-3)}
.sx-feature .sx-body p{margin:0}
@media (max-width:640px){.sx-feature{grid-template-columns:120px minmax(0,1fr);grid-template-areas:"photo head" "body body";column-gap:var(--space-4)}.sx-feature .sx-head{align-self:center}.sx-name{font-size:var(--text-xl)}}
.sx-kicker{font-weight:800;font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;color:var(--color-text-muted)}
.sx-name{font-family:var(--font-display);font-size:var(--text-2xl);line-height:1;margin:var(--space-1) 0 var(--space-2)}
.sx-head p{margin:0}
.sx-muted{color:var(--color-text-muted);font-size:var(--text-sm)}
.sx-tag{display:inline-block;border:2px solid var(--color-border);border-radius:6px;padding:0 6px;font-size:.7rem;font-weight:800;margin-left:6px;vertical-align:middle;transform:rotate(-3deg);background:var(--color-surface-offset)}
.sx-says{background:var(--color-surface-offset);border-radius:var(--radius-xl);padding:var(--space-6) var(--space-5);margin-block:var(--space-8)}
.sx-says h3{font-family:var(--font-display);font-size:var(--text-xl);margin:var(--space-2) 0 var(--space-4);line-height:1.15}
.sx-bubble{max-width:85%;background:var(--color-surface);border-radius:18px 18px 18px 4px;padding:10px 14px;margin:0 0 10px}
.sx-bubble:nth-of-type(even){margin-left:auto;border-radius:18px 18px 4px 18px}
.sx-bubble b{display:block;font-size:var(--text-xs);color:var(--color-text-muted)}
.sx-ask{background:var(--color-primary-light);border-radius:var(--radius-xl);padding:var(--space-6) var(--space-5);text-align:center;display:grid;gap:var(--space-3);justify-items:center;margin-block:var(--space-8)}
.sx-ask h3{font-family:var(--font-display);font-size:var(--text-xl);line-height:1.2;margin:0;max-width:24ch}
.sx-ask p{margin:0;max-width:44ch}.sx-quote-mark{font-family:var(--font-display);font-size:56px;line-height:.5;margin-top:var(--space-3);color:var(--color-primary)}
.sx-good{border-top:3px solid var(--color-border);padding-top:var(--space-5);margin-block:var(--space-8)}
.sx-good h3{font-family:var(--font-display);font-size:var(--text-xl);margin:var(--space-2) 0 var(--space-3)}
.sx-good ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-3)}
.sx-good li{padding-left:28px;position:relative}
.sx-good li::before{content:"✓";position:absolute;left:0;font-weight:800}
</style>`;

// Each section has its own look, like the email: an open list, a photo
// feature, a tinted band of chat bubbles, a checklist under a rule.
export function sectionsHomeHtml(s, { siteUrl }) {
  if (!s || !(s.pet || (s.places && s.places.length) || s.roundup || s.good || s.question)) return '';
  const parts = [];
  if (s.places && s.places.length) {
    parts.push(`<section id="new-in-town">
        <h2 class="section-heading">New in town</h2>
        <ul class="notable-list" role="list">${s.places.map(x => `
          <li class="notable-entry"><div class="notable-details"><div class="notable-name">${escHtml(x.name)}<span class="sx-tag">${x.status === 'soon' ? 'SOON' : 'NEW'}</span></div><div class="notable-desc">${escHtml(x.line)}</div></div></li>`).join('')}
        </ul>
      </section>`);
  }
  if (s.pet) {
    const p = s.pet;
    parts.push(`<section class="sx-feature" id="pet-of-the-week">
        <img src="${siteUrl}/sections/pet/${encodeURIComponent(p.id)}.jpg" alt="${escHtml(p.name)}" width="260" height="260" loading="lazy">
        <div class="sx-head"><span class="sx-kicker">Pet of the week</span>
          <h2 class="sx-name">${escHtml(p.name)}</h2>
          <p class="sx-muted">${escHtml(p.facts || '')}</p></div>
        <div class="sx-body"><p>${escHtml(p.blurb)}</p>
          ${safeUrl(p.url) ? `<a class="btn btn--outline" href="${escHtml(p.url)}" rel="noopener">Meet ${escHtml(p.name)}</a>` : ''}
          <p class="sx-muted">At ${escHtml(p.shelter)}${p.shelter_address ? `, ${escHtml(p.shelter_address)}` : ''}. Photo: ${escHtml(p.shelter)}.</p></div>
      </section>`);
  }
  if (s.roundup) {
    parts.push(`<section class="sx-says" id="readers-say"><span class="sx-kicker">${escHtml(town.city)} says</span>
        <h3>${escHtml(s.roundup.question || 'You answered')}</h3>
        ${s.roundup.answers.map(a => `<p class="sx-bubble">${escHtml(a.quote)}${a.name ? `<b>${escHtml(a.name)}</b>` : ''}</p>`).join('')}
        <a class="btn btn--primary" href="/subscribe">Answer next week's question</a>
      </section>`);
  }
  if (s.question) {
    // The signup hook: answering means getting Monday's email. The button
    // goes to the footer's signup form.
    parts.push(`<section class="sx-ask" id="question-of-the-week"><span class="sx-kicker">Question of the week</span>
        <div class="sx-quote-mark" aria-hidden="true">“</div>
        <h3>${escHtml(s.question)}</h3>
        <p class="sx-muted">Get Monday's email and hit reply with your answer. We share favorites on Thursday.</p>
        <a class="btn btn--primary" href="#subscribe">Count me in</a>
      </section>`);
  }
  if (s.good) {
    parts.push(`<section class="sx-good" id="good-news"><span class="sx-kicker">From City Hall</span>
        <h3>On the agenda this week</h3>
        <ul>${s.good.items.map(g => `<li><b>${escHtml(g.title)}.</b> ${escHtml(g.line)}</li>`).join('')}</ul>
        ${safeUrl(s.good.url) ? `<p class="sx-muted"><a href="${escHtml(s.good.url)}" rel="noopener">The full agenda</a></p>` : ''}
      </section>`);
  }
  return `${HOME_CSS}
      <section id="sections">
      ${parts.join('\n      ')}
        <hr class="section-sep">
      </section>

      `;
}

// ─── The sections' own pages ───────────────────────────────────────────
// /new-in-town, /pets and /city-hall keep what the issues showed, so it
// lasts past the email and people can find it on Google. The archive is
// its own town file (sections_archive), added to each time the worker
// hands in a sections file; what the owner takes out comes out of it too.
export const SECTION_PAGES = [
  { path: '/new-in-town', nav: 'New in Town' },
  { path: '/pets', nav: 'Pets' },
  { path: '/city-hall', nav: 'City Hall' }
];
const ARCHIVE = { places: 300, pets: 12, hall: 52 };

// This week's items in the archive, minus what the owner took out.
export function syncArchive(archive, file, hidden = []) {
  const a = { places: [], pets: [], hall: [], ...(archive || {}) };
  if (!file || !file.week) return a;
  const week = file.week, off = new Set(hidden);
  a.places = a.places.filter(x => x.week !== week);
  for (const x of file.new_in_town || []) {
    if (!x || !x.name || off.has(`place:${x.key}`)) continue;
    // A place shown before as "soon" that's now open moves up as open.
    a.places = a.places.filter(y => y.key !== x.key);
    a.places.unshift({ key: x.key, name: x.name, line: x.line, status: x.status, week });
  }
  a.pets = a.pets.filter(x => x.week !== week);
  if (file.pet && file.pet.photo && !off.has('pet')) {
    const { id, name, facts, blurb, shelter, shelter_address: address, url, photo } = file.pet;
    a.pets = a.pets.filter(x => x.id !== id);
    a.pets.unshift({ id, name, facts, blurb, shelter, shelter_address: address, url, photo, week });
  }
  a.hall = a.hall.filter(x => x.week !== week);
  if (file.good_news && !off.has('good')) {
    const items = (file.good_news.items || []).filter((g, i) => !off.has(`good:${i}`));
    if (items.length) a.hall.unshift({ week, items, url: file.good_news.url || '', body: file.good_news.body || '' });
  }
  const byWeek = (x, y) => (x.week < y.week ? 1 : x.week > y.week ? -1 : 0);
  a.places = a.places.sort(byWeek).slice(0, ARCHIVE.places);
  a.pets = a.pets.sort(byWeek).slice(0, ARCHIVE.pets);
  a.hall = a.hall.sort(byWeek).slice(0, ARCHIVE.hall);
  return a;
}

const monthName = ymd => new Date(ymd.slice(0, 7) + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const weekName = ymd => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const PAGE_CSS = `<style>
.sx-hero{padding-block:var(--space-6) var(--space-2)}.sx-hero h1{font-family:var(--font-display);font-size:var(--text-2xl);line-height:1.05;margin:var(--space-2) 0}
.sx-kicker{font-weight:800;font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;color:var(--color-text-muted)}
.sx-muted{color:var(--color-text-muted)}
.sx-month{font-family:var(--font-display);font-size:var(--text-xl);margin:var(--space-8) 0 var(--space-2)}
.sx-tag{display:inline-block;border:2px solid var(--color-border);border-radius:6px;padding:0 6px;font-size:.7rem;font-weight:800;margin-left:6px;vertical-align:middle;transform:rotate(-3deg);background:var(--color-surface-offset)}
.sx-join{background:var(--color-surface-offset);border-radius:var(--radius-xl);padding:var(--space-5);margin-block:var(--space-8);display:grid;gap:var(--space-3)}
.sx-join h2{font-family:var(--font-display);font-size:var(--text-lg);margin:0}.sx-join p{margin:0}
.sx-feature{display:grid;grid-template-columns:minmax(0,240px) minmax(0,1fr);grid-template-areas:"photo head" "photo body";column-gap:var(--space-6);align-items:start;margin-block:var(--space-6)}
.sx-feature img{grid-area:photo;width:100%;max-width:240px;aspect-ratio:1;object-fit:cover;border:3px solid var(--color-border);border-radius:var(--radius-xl);box-shadow:6px 6px 0 var(--color-border)}
.sx-feature .sx-head{grid-area:head;align-self:end}.sx-feature .sx-body{grid-area:body;display:grid;gap:var(--space-3);justify-items:start;margin-top:var(--space-3)}
.sx-feature p{margin:0}.sx-name{font-family:var(--font-display);font-size:var(--text-2xl);line-height:1;margin:var(--space-1) 0 var(--space-2)}
@media (max-width:640px){.sx-feature{grid-template-columns:120px minmax(0,1fr);grid-template-areas:"photo head" "body body";column-gap:var(--space-4)}.sx-feature .sx-head{align-self:center}.sx-name{font-size:var(--text-xl)}}
.sx-pets{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:var(--space-4);margin-top:var(--space-3)}
.sx-pets figure{margin:0}.sx-pets img{width:100%;aspect-ratio:1;object-fit:cover;border:2px solid var(--color-border);border-radius:14px}
.sx-pets figcaption{font-weight:800;margin-top:6px}.sx-pets small{display:block;color:var(--color-text-muted);font-weight:600}
.sx-week{border-top:3px solid var(--color-border);padding-top:var(--space-4);margin-top:var(--space-6)}
.sx-week ul{list-style:none;padding:0;margin:var(--space-2) 0 0;display:grid;gap:var(--space-3)}.sx-week li{padding-left:26px;position:relative}.sx-week li::before{content:"✓";position:absolute;left:0;font-weight:800}
</style>`;

function joinBox(signupHtml) {
  return `<section class="sx-join"><h2>Get what's new in your inbox</h2>
    <p class="sx-muted">New places, the pet of the week and everything happening in ${escHtml(town.city)}, every Monday and Thursday. Free.</p>
    ${signupHtml}</section>`;
}

export function renderSectionPage(kind, archive, { siteUrl, signupHtml = '' }) {
  const a = archive || { places: [], pets: [], hall: [] };
  let title, description, body, image = null, imageSize = null;
  if (kind === 'new-in-town') {
    title = `New in ${town.city}: places that just opened | ${town.siteName}`;
    description = `Restaurants, shops and spots that just opened or are opening soon in ${town.cityState}, updated every week.`;
    const months = [];
    for (const x of a.places) {
      const m = monthName(x.week);
      if (!months.length || months[months.length - 1].m !== m) months.push({ m, list: [] });
      months[months.length - 1].list.push(x);
    }
    body = `<section class="sx-hero"><span class="sx-kicker">Updated every week</span><h1>New in ${escHtml(town.city)}</h1>
      <p class="sx-muted">Restaurants, shops and spots that just opened or are about to, around ${escHtml(town.city)}.</p></section>
      ${months.length ? months.map(({ m, list }) => `<h2 class="sx-month">${escHtml(m)}</h2><ul class="notable-list" role="list">${list.map(x => `
        <li class="notable-entry"><div class="notable-details"><div class="notable-name">${escHtml(x.name)}<span class="sx-tag">${x.status === 'soon' ? 'SOON' : 'NEW'}</span></div><div class="notable-desc">${escHtml(x.line)}</div></div></li>`).join('')}</ul>`).join('')
        : '<p class="sx-muted">The first new places show up here soon.</p>'}`;
    if (a.places.length) image = '/sections/cards/new-in-town.png';
  } else if (kind === 'pets') {
    const [now, ...before] = a.pets;
    title = now ? `Meet ${now.name}, our pet of the week | ${town.siteName}` : `Pets looking for a home | ${town.siteName}`;
    description = `Every week ${town.siteName} features a pet from a ${town.city} shelter. Here's this week's, and the ones before.`;
    body = `<section class="sx-hero"><span class="sx-kicker">Adopt, don't shop</span><h1>Pets looking for a home</h1>
      <p class="sx-muted">Every week we feature a pet from a ${escHtml(town.city)} shelter. Here's this week's, and the ones before.</p></section>
      ${now ? `<section class="sx-feature"><img src="/sections/pet/${encodeURIComponent(now.id)}.jpg" alt="${escHtml(now.name)}" width="240" height="240">
        <div class="sx-head"><span class="sx-kicker">Pet of the week</span><h2 class="sx-name">${escHtml(now.name)}</h2><p class="sx-muted">${escHtml(now.facts || '')}</p></div>
        <div class="sx-body"><p>${escHtml(now.blurb || '')}</p>${safeUrl(now.url) ? `<a class="btn btn--primary" href="${escHtml(now.url)}" rel="noopener">Meet ${escHtml(now.name)}</a>` : ''}
        <p class="sx-muted">At ${escHtml(now.shelter || '')}${now.shelter_address ? `, ${escHtml(now.shelter_address)}` : ''}. Photo: ${escHtml(now.shelter || '')}.</p></div></section>` : '<p class="sx-muted">This week\'s pet shows up here soon.</p>'}
      ${before.length ? `<h2 class="sx-month">Recently featured</h2><div class="sx-pets">${before.map(x => `<figure><img src="/sections/pet/${encodeURIComponent(x.id)}.jpg" alt="${escHtml(x.name)}" width="150" height="150" loading="lazy"><figcaption>${escHtml(x.name)}<small>${escHtml(x.facts || '')}</small></figcaption></figure>`).join('')}</div>
        <p class="sx-muted">Some may have found homes already. Ask the shelter.</p>` : ''}`;
    if (now) { image = `/sections/cards/pet-${encodeURIComponent(now.id)}.png`; }
  } else {
    title = `From City Hall | ${town.siteName}`;
    description = `Updates from the ${town.city} city and county meetings: parks, the library, events and more.`;
    body = `<section class="sx-hero"><span class="sx-kicker">From City Hall</span><h1>What's on the agenda</h1>
      <p class="sx-muted">Updates from the city and county meetings: parks, the library, events and more.</p></section>
      ${a.hall.length ? a.hall.map(w => `<section class="sx-week"><span class="sx-kicker">Week of ${escHtml(weekName(w.week))}</span><ul>${w.items.map(g => `<li><b>${escHtml(g.title)}.</b> ${escHtml(g.line)}</li>`).join('')}</ul>
        ${safeUrl(w.url) ? `<p class="sx-muted"><a href="${escHtml(w.url)}" rel="noopener">The full agenda</a></p>` : ''}</section>`).join('')
        : '<p class="sx-muted">The first updates show up here soon.</p>'}`;
  }
  if (image) imageSize = [1200, 630];
  return layout({ siteUrl, path: `/${kind}`, title, description, body: PAGE_CSS + body + joinBox(signupHtml), ...(image ? { image, imageSize } : {}) });
}

// ─── The poll results page ──────────────────────────────────────────────

export function renderPollPage(poll, counts, { voted = null, siteUrl }) {
  const total = Object.values(counts).reduce((n, x) => n + x, 0);
  const rows = poll.choices.map((c, i) => {
    const n = counts[i] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    return `<div class="poll-row${voted === i ? ' poll-row--mine' : ''}"><span>${escHtml(c)}${voted === i ? ' <b>(you)</b>' : ''}</span><span class="poll-track"><i style="width:${pct}%"></i></span><span>${pct}%</span></div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(poll.question)} · ${escHtml(town.siteName)}</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400..700&family=Nunito:wght@400..900&display=swap">
<link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/style.css">
<style>.poll{max-width:560px;margin:40px auto;padding:0 16px;display:grid;gap:16px}.poll-card{background:var(--color-surface);border:3px solid var(--color-border);border-radius:var(--radius-xl);box-shadow:5px 5px 0 var(--color-border);padding:20px;display:grid;gap:12px}
.poll-row{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 44px;gap:10px;align-items:center}.poll-track{height:14px;border:2px solid var(--color-border);border-radius:99px;overflow:hidden;background:var(--color-bg)}
.poll-track i{display:block;height:100%;background:var(--color-primary, #4B3FD1)}.poll h1{font-family:var(--font-display);font-size:var(--text-xl);margin:0;line-height:1.15}
body{font-family:var(--font-body)}.poll-back{color:var(--color-text);font-weight:800;text-decoration:none;font-family:var(--font-display)}.poll-row--mine span:first-child{font-weight:800}</style></head>
<body><main class="poll"><p><a class="poll-back" href="/">← ${escHtml(town.siteName)}</a></p><div class="poll-card">
<h1>${escHtml(poll.question)}</h1>${voted != null ? '<p>Thanks for voting! Here is how readers answered so far.</p>' : '<p>How readers answered so far.</p>'}
${rows}<p class="sx-muted">${total} ${total === 1 ? 'vote' : 'votes'}</p></div>
<p><a class="btn btn--primary" href="${siteUrl}/">See what's happening this week</a></p></main></body></html>`;
}

// ─── The email side's helpers (server/newsletter.js renders the blocks) ─

export function petPhotoUrl(siteUrl, pet) { return `${siteUrl}/sections/pet/${encodeURIComponent(pet.id)}.jpg`; }
export function pollVoteUrl(siteUrl, monday, poll, choice, subscriberId) {
  return `${siteUrl}/p/${monday}/${encodeURIComponent(poll.id)}/${choice}${subscriberId ? `?s=${encodeURIComponent(subscriberId)}` : ''}`;
}

const isBot = ua => !ua || /bot|crawl|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|python|curl|wget|headless|monitor/i.test(ua);

// First name for the roundup: "Maria Lopez <m@x.com>" → Maria.
export function firstName(from) {
  const m = /^\s*"?([^"<@]+?)"?\s*</.exec(String(from || ''));
  const first = m ? m[1].trim().split(/\s+/)[0] : '';
  return /^[A-Za-zÀ-ÿ'-]{2,20}$/.test(first) ? first[0].toUpperCase() + first.slice(1) : '';
}

/**
 * The routes, the reply hook for server/inbound.js, the jobs hooks.
 * store: getTownFile/setTownFile, saveReaderReply, listReaderReplies,
 * recordPollVote, deletePollVote, countPollVotes.
 */
export function createSections({ store, cfg = sectionsConfig(), slack = null, siteUrl = '', nowFn = () => new Date(), log = console }) {
  let cache = { at: 0, file: null, hidden: [] };
  async function current() {
    if (Date.now() - cache.at < 60 * 1000) return cache;
    try {
      const f = typeof store.getTownFile === 'function' ? await store.getTownFile('sections') : null;
      const h = typeof store.getTownFile === 'function' ? await store.getTownFile('sections_hidden') : null;
      const file = f ? f.data : null;
      const hidden = h && h.data && file && h.data.week === file.week && Array.isArray(h.data.ids) ? h.data.ids : [];
      cache = { at: Date.now(), file, hidden };
    } catch (err) { log.warn('[sections] read failed:', err.message); }
    return cache;
  }

  async function forIssue(edition, now = nowFn()) {
    if (!cfg.enabled) return null;
    const { file, hidden } = await current();
    return sectionsFor({ cfg, file, hidden, edition, now });
  }

  async function forHome(now = nowFn()) {
    if (!cfg.enabled) return '';
    const { file, hidden } = await current();
    return sectionsHomeHtml(homeSections({ cfg, file, hidden, now }), { siteUrl });
  }

  // A reply to any issue (server/inbound.js): kept for Thursday's roundup.
  async function saveReply({ id, from, email, subject, text, at }) {
    if (!cfg.enabled || typeof store.saveReaderReply !== 'function' || !text || /^(re:\s*)?(sponsor|pick|order|advertis|refund|invoice)/i.test(subject || '')) return false;
    return store.saveReaderReply({ id, created_at: at || nowFn().toISOString(), name: firstName(from), email, subject, text: String(text).slice(0, 2000) });
  }

  async function listReplies(since) {
    if (!cfg.enabled || typeof store.listReaderReplies !== 'function') return [];
    // The worker sees the words and a first name, never the address.
    return (await store.listReaderReplies(since)).map(r => ({ at: r.created_at, name: r.name, subject: r.subject, text: r.text }));
  }

  async function readArchive() {
    try {
      const f = typeof store.getTownFile === 'function' ? await store.getTownFile('sections_archive') : null;
      return f && f.data ? f.data : { places: [], pets: [], hall: [] };
    } catch (err) { log.warn('[sections] archive read failed:', err.message); return { places: [], pets: [], hall: [] }; }
  }
  // This week's items into the archive (the pages), minus what's taken out.
  async function refreshArchive() {
    if (!cfg.enabled || typeof store.setTownFile !== 'function') return;
    cache.at = 0;
    const { file, hidden } = await current();
    if (!file) return;
    await store.setTownFile('sections_archive', syncArchive(await readArchive(), file, hidden), nowFn());
  }

  // After the worker hands in a new file: the archive, and one Slack note
  // with what readers will see and where to take something out.
  async function onFile(name, data) {
    if (name !== 'sections' || !data) return;
    cache.at = 0;
    await refreshArchive().catch(err => log.warn('[sections] archive:', err.message));
    if (!slack) return;
    const lines = [];
    if (data.pet) lines.push(`🐾 Pet: ${data.pet.name} (${data.pet.shelter})`);
    if ((data.new_in_town || []).length) lines.push(`🏪 New in town: ${data.new_in_town.map(x => x.name).join(', ')}`);
    if (data.good_news) lines.push(`🏛️ City Hall: ${data.good_news.items.map(x => x.title).join(', ')}`);
    if (data.roundup) lines.push(`💬 Readers' answers: ${data.roundup.answers.length}`);
    if ((data.questions_added || []).length) lines.push(`❓ New questions for the weeks ahead: ${data.questions_added.map(q => `“${q}”`).join(' ')}`);
    const dropped = (data.review || []).filter(r => r.verdict === 'drop').length;
    slack.notify({ title: '🗞️ Newsletter sections ready', channel: 'activity', link: `${siteUrl}/admin.html#tab=newsletter`, linkLabel: 'Take something out',
      text: [lines.join('\n') || 'Nothing new this time.', dropped ? `The editor left out ${dropped} item${dropped === 1 ? '' : 's'}.` : ''].filter(Boolean).join('\n') });
  }

  // The pet's photo: this week's, or one on the Pets page.
  async function petPhoto(id) {
    const { file } = await current();
    if (file && file.pet && file.pet.id === id && file.pet.photo) return file.pet;
    return ((await readArchive()).pets || []).find(p => p.id === id && p.photo) || null;
  }

  // signupHtml(): the newsletter signup form (server/newsletter.js), for the pages.
  function register(app, { requireAdmin, sendHtml = (res, html) => res.type('html').send(html), signupHtml = () => '' }) {
    if (cfg.enabled) {
      for (const page of SECTION_PAGES) {
        app.get(page.path, async (req, res, next) => {
          try { sendHtml(res, renderSectionPage(page.path.slice(1), await readArchive(), { siteUrl, signupHtml: signupHtml(page.path.slice(1)) })); } catch (err) { next(err); }
        });
      }
      app.get('/sections/cards/new-in-town.png', async (req, res) => {
        const a = await readArchive();
        if (!a.places.length) return res.status(404).end();
        res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600');
        res.send(renderSectionCard({ kicker: 'New in town', title: `New in ${town.city}`, lines: a.places.slice(0, 3).map(x => x.name) }));
      });
      app.get('/sections/cards/pet-:id.png', async (req, res) => {
        const pet = await petPhoto(req.params.id);
        if (!pet) return res.status(404).end();
        res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=604800');
        res.send(renderSectionCard({ kicker: 'Pet of the week', title: `Meet ${pet.name}`, lines: [pet.shelter || ''], photo: pet.photo }));
      });
    }
    app.get('/sections/pet/:id.jpg', async (req, res) => {
      const pet = await petPhoto(req.params.id);
      if (!pet) return res.status(404).end();
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      res.send(Buffer.from(pet.photo, 'base64'));
    });

    app.get('/p/:week/:poll/:choice', async (req, res) => {
      const { week, poll: pollId } = req.params;
      const choice = Number(req.params.choice);
      const poll = /^\d{4}-\d{2}-\d{2}$/.test(week) ? pollFor(cfg, week) : null;
      if (!poll || poll.id !== pollId || !Number.isInteger(choice) || choice < 0 || choice >= poll.choices.length) return res.redirect(302, '/');
      const sub = String(req.query.s || '').slice(0, 64);
      let voted = null;
      if (sub && req.method === 'GET' && !isBot(req.get('User-Agent')) && typeof store.recordPollVote === 'function') {
        try {
          const at = nowFn().toISOString();
          const r = await store.recordPollVote({ week, poll: pollId, subscriber_id: sub, choice, at });
          if (r && r.prior && r.prior.choice !== choice && Date.parse(at) - Date.parse(r.prior.at) < SCANNER_BURST_MS) {
            await store.deletePollVote({ week, poll: pollId, subscriber_id: sub });
          } else if (r) voted = choice;
        } catch (err) { log.warn('[sections] vote failed:', err.message); }
      }
      res.redirect(302, `/poll/${week}/${encodeURIComponent(pollId)}${voted != null ? `?v=${voted}` : ''}`);
    });

    app.get('/poll/:week/:poll', async (req, res) => {
      const poll = /^\d{4}-\d{2}-\d{2}$/.test(req.params.week) ? pollFor(cfg, req.params.week) : null;
      if (!poll || poll.id !== req.params.poll) return res.status(404).send('Not found');
      const counts = typeof store.countPollVotes === 'function' ? await store.countPollVotes(req.params.week, poll.id).catch(() => ({})) : {};
      const v = req.query.v != null ? Number(req.query.v) : null;
      res.set('Cache-Control', 'no-store');
      res.type('html').send(renderPollPage(poll, counts, { voted: Number.isInteger(v) ? v : null, siteUrl }));
    });

    app.get('/api/admin/sections', requireAdmin, async (req, res) => {
      cache.at = 0;
      const { file, hidden } = await current();
      const monday = mondayOf(localDateStr(nowFn()));
      const f = file || {};
      res.json({ ok: true, enabled: cfg.enabled, week: f.week || null, built_at: f.built_at || null, hidden,
        question: f.week === monday && f.question ? f.question : questionFor(cfg, monday), poll: pollFor(cfg, monday),
        upcoming_questions: (f.question_bank || []).slice(0, 8),
        pet: f.pet ? { ...f.pet, photo: undefined, photo_url: petPhotoUrl('', f.pet) } : null,
        new_in_town: f.new_in_town || [], good_news: f.good_news || null, roundup: f.roundup || null, review: f.review || [] });
    });

    app.post('/api/admin/sections/hide', requireAdmin, async (req, res) => {
      const id = String((req.body || {}).id || '');
      if (!/^(pet|question|poll|good|roundup|place:[\w-]+|good:\d+|reply:\d+|bank:[a-f0-9]{10})$/.test(id)) return res.status(400).json({ ok: false, error: 'bad-id' });
      const { file } = await current();
      const week = file && file.week;
      if (!week) return res.status(404).json({ ok: false, error: 'no-sections' });
      // A question coming up in the weeks ahead: taken out of the bank for
      // good (the job reads the bank back from this file).
      if (id.startsWith('bank:')) {
        const f = await store.getTownFile('sections');
        const data = f && f.data ? f.data : {};
        data.question_bank = (data.question_bank || []).filter(b => `bank:${b.id}` !== id);
        await store.setTownFile('sections', data, nowFn());
        cache.at = 0;
        return res.json({ ok: true, removed: id });
      }
      const h = await store.getTownFile('sections_hidden');
      const ids = new Set(h && h.data && h.data.week === week ? h.data.ids : []);
      if ((req.body || {}).hidden === false) ids.delete(id); else ids.add(id);
      await store.setTownFile('sections_hidden', { week, ids: [...ids] }, nowFn());
      cache.at = 0;
      await refreshArchive().catch(err => log.warn('[sections] archive:', err.message));
      res.json({ ok: true, hidden: [...ids] });
    });
  }

  return { enabled: cfg.enabled, cfg, forIssue, forHome, saveReply, listReplies, onFile, register, refreshArchive };
}
