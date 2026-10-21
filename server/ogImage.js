/**
 * Link-preview card for one event: /events/<slug>.png, 1200x630.
 *
 * When someone texts or posts an event link, iMessage, Facebook and X show
 * this image above the title. A card with the event's own name, day, time
 * and place gets tapped far more than the generic site image, and sharing
 * is how the site grows. Drawn as SVG and rasterized with resvg (a
 * prebuilt binary, no system Chrome or fonts needed on Railway), in the
 * same palette and fonts as the site and the social-kit slides.
 */
import { town, townAssetPath } from './town.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { formatDay, formatTime, placeText } from './seo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_FILES = [join(HERE, 'fonts', 'Fredoka-Bold.ttf'), join(HERE, 'fonts', 'Nunito-ExtraBold.ttf')];

export const W = 1200, H = 630;
// Same palette and per-weekday colors as docs/style.css and scripts/social_slides.py.
const INK = '#1F1A3D', SUN = '#FFC93C', MUTED = '#554E7A';
const DAY_COLORS = ['#FFC93C', '#8FD3FF', '#FF8FC0', '#3DBE8B', '#FF7A3D', '#B9A6FF', '#FF8A80']; // Mon..Sun

// The town's logo and skyline (its overlay copy, else Victoria's in docs/).
const dataUri = file => `data:image/svg+xml;base64,${readFileSync(townAssetPath(file)).toString('base64')}`;
let assets = null;
function getAssets() {
  if (!assets || assets.town !== town.id) assets = { town: town.id, logo: dataUri('logo.svg'), skyline: dataUri('skyline.svg') };
  return assets;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Wrap on estimated widths: em per character group, measured from the two
// bundled fonts (resvg's getBBox) with a couple of percent to spare, so a
// line never spills past the margin. Nunito runs about 5% wider.
function textWidth(s, size, font = 'Fredoka') {
  let em = 0;
  for (const ch of s) {
    if (/[ il.,:;!'|’]/.test(ch)) em += 0.24;
    else if (/[fjrt()\-]/.test(ch)) em += 0.39;
    else if (/[mwMW@–]/.test(ch)) em += 0.84;
    else if (/[A-Z0-9&]/.test(ch)) em += 0.61;
    else em += 0.555;
  }
  return em * size * (font === 'Nunito' ? 1.06 : 1);
}

// The bundled fonts have no emoji glyphs and system fonts are off, so an
// emoji in a name ("Well Appointed Wednesdays 🍷 🍺") would draw as empty
// boxes. Drop pictographs and the joiners, variation selectors, keycap marks,
// skin tones and flag letters that build emoji sequences before measuring.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}]/gu;
export function stripEmoji(s) {
  return String(s == null ? '' : s).replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
}

// Bump when the drawing changes in a way the drawn fields don't capture (like
// the emoji strip), so shared pages get a new og:image URL and Facebook's
// cached copy of the old card is replaced.
export const CARD_RENDER_VERSION = 2;

function ellipsize(s, size, max, font) {
  if (textWidth(s, size, font) <= max) return s;
  let out = s;
  while (out && textWidth(out + '…', size, font) > max) out = out.slice(0, -1);
  return out.trimEnd() + '…';
}

function wrap(text, size, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (!line || textWidth(next, size) <= max) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// Biggest name size that fits the allowed lines and leaves room for the
// time/place line above the skyline (baseline at most META_MAX); long names
// drop to a smaller size with a third line, then get cut with an ellipsis.
const META_MAX = 498, META_GAP = 70;
const lineHeight = size => Math.round(size * 1.08);
const firstBaseline = (top, size) => top + Math.round(size * 0.9);

function fitName(name, max, top) {
  for (const [size, maxLines] of [[92, 2], [78, 2], [66, 3], [58, 3], [52, 3]]) {
    const lines = wrap(name, size, max);
    const metaY = firstBaseline(top, size) + (lines.length - 1) * lineHeight(size) + META_GAP;
    if (lines.length <= maxLines && metaY <= META_MAX && lines.every(l => textWidth(l, size) <= max)) return { size, lines };
  }
  const size = 52;
  const lines = wrap(name, size, max).map(l => ellipsize(l, size, max));
  if (lines.length > 3) lines.splice(2, lines.length - 2, ellipsize(`${lines[2]} ${lines[3]}`, size, max));
  return { size, lines };
}

function pill(x, y, text, size, fill, { padX = 22, h = size * 1.5 } = {}) {
  const w = textWidth(text, size) + padX * 2;
  return {
    w,
    svg: `<rect x="${x + 5}" y="${y + 5}" width="${w}" height="${h}" rx="${h / 2}" fill="${INK}"/>` +
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${INK}" stroke-width="5"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 + size * 0.36}" text-anchor="middle" font-family="Fredoka" font-weight="700" font-size="${size}" fill="${INK}">${esc(text)}</text>`
  };
}

export function eventCardSvg(ev) {
  const { logo, skyline } = getAssets();
  const left = 64, max = W - left * 2;
  const weekday = (new Date(`${ev.date}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
  const day = formatDay(ev.date, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();

  const parts = [];
  // Header: logo + name on the left, the day pill on the right.
  parts.push(`<image href="${logo}" x="${left}" y="40" width="92" height="92"/>`);
  parts.push(`<text x="${left + 112}" y="104" font-family="Fredoka" font-weight="700" font-size="46" fill="${INK}">${town.siteName}</text>`);
  const dayPillW = textWidth(day, 38) + 44;
  parts.push(pill(W - left - dayPillW - 5, 52, day, 38, DAY_COLORS[weekday]).svg);

  let y = 170;
  if (ev.featured) {
    // The town's own pick name (Victoria: "VIC’S PICK", as before).
    parts.push(pill(left, y, town.pickName.toUpperCase(), 30, SUN, { padX: 20 }).svg);
    y += 68;
  }

  const name = fitName(stripEmoji(ev.name), max, y);
  y = firstBaseline(y, name.size);
  name.lines.forEach((line, i) => {
    if (i) y += lineHeight(name.size);
    parts.push(`<text x="${left}" y="${y}" font-family="Fredoka" font-weight="700" font-size="${name.size}" fill="${INK}">${esc(line)}</text>`);
  });

  // "7 PM · Moonshine Drinkery · Free" under the name.
  const meta = [formatTime(ev.time), placeText(ev).split(' · ')[0], ev.free === true ? 'Free' : '']
    .map(stripEmoji).filter(Boolean).join(' · ');
  if (meta) {
    y += META_GAP;
    parts.push(`<text x="${left}" y="${y}" font-family="Nunito" font-weight="800" font-size="36" fill="${MUTED}">${esc(ellipsize(meta, 36, max, 'Nunito'))}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#DDF0FA"/><stop offset="1" stop-color="#FFF4D6"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="16" fill="${DAY_COLORS[weekday]}"/>
<image href="${skyline}" x="0" y="${H - 112}" width="${W}" height="112" preserveAspectRatio="xMidYMax slice"/>
${parts.join('\n')}
</svg>`;
}

// Changes whenever anything drawn on the card changes, so the page can put
// it in the image URL and Facebook's cached preview updates with it.
export function eventCardVersion(ev) {
  const drawn = [CARD_RENDER_VERSION, ev.name, ev.date, ev.time, ev.venue, ev.address, ev.featured === true, ev.free === true];
  return createHash('sha1').update(JSON.stringify(drawn)).digest('hex').slice(0, 10);
}

// Rendering takes tens of milliseconds; a week has a few dozen events and a
// shared link gets fetched by every app it lands in, so keep recent cards.
const CACHE_MAX = 150; // ~80 KB each, so about 12 MB at most
const cache = new Map();

export function renderEventCard(ev) {
  const key = `${ev.page}|${eventCardVersion(ev)}`;
  let png = cache.get(key);
  if (!png) {
    png = new Resvg(eventCardSvg(ev), {
      fitTo: { mode: 'original' },
      font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Nunito' }
    }).render().asPng();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, png);
  }
  return png;
}

// The newsletter sections' share cards (server/sections.js): the pet of the
// week with its photo, or New in Town with its newest places. Same look as
// the event cards; `photo` is the pet's JPEG as base64.
export function sectionCardSvg({ kicker, title, lines = [], photo = null }) {
  const { logo, skyline } = getAssets();
  const left = 64;
  const textLeft = photo ? 560 : left;
  const max = W - textLeft - 64;
  const parts = [];
  if (photo) {
    parts.push(`<clipPath id="ph"><rect x="64" y="64" width="440" height="440" rx="28"/></clipPath>`);
    parts.push(`<rect x="72" y="72" width="440" height="440" rx="28" fill="${INK}"/>`);
    parts.push(`<image href="data:image/jpeg;base64,${photo}" x="64" y="64" width="440" height="440" preserveAspectRatio="xMidYMid slice" clip-path="url(#ph)"/>`);
    parts.push(`<rect x="64" y="64" width="440" height="440" rx="28" fill="none" stroke="${INK}" stroke-width="6"/>`);
  }
  parts.push(`<text x="${textLeft}" y="${photo ? 150 : 120}" font-family="Nunito" font-weight="800" font-size="30" letter-spacing="4" fill="#FF7A3D">${esc(stripEmoji(kicker).toUpperCase())}</text>`);
  const t = fitName(stripEmoji(title), max, photo ? 170 : 140);
  let y = firstBaseline(photo ? 170 : 140, t.size);
  t.lines.forEach((line, i) => {
    if (i) y += lineHeight(t.size);
    parts.push(`<text x="${textLeft}" y="${y}" font-family="Fredoka" font-weight="700" font-size="${t.size}" fill="${INK}">${esc(line)}</text>`);
  });
  for (const line of lines.slice(0, 3)) {
    y += 54;
    parts.push(`<text x="${textLeft}" y="${y}" font-family="Nunito" font-weight="800" font-size="34" fill="${MUTED}">${esc(ellipsize(stripEmoji(line), 34, max, 'Nunito'))}</text>`);
  }
  parts.push(`<image href="${logo}" x="${textLeft}" y="${H - 200}" width="64" height="64"/>`);
  parts.push(`<text x="${textLeft + 80}" y="${H - 155}" font-family="Fredoka" font-weight="700" font-size="40" fill="${INK}">${esc(town.siteName)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#DDF0FA"/><stop offset="1" stop-color="#FFF4D6"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="16" fill="${SUN}"/>
<image href="${skyline}" x="0" y="${H - 112}" width="${W}" height="112" preserveAspectRatio="xMidYMax slice"/>
${parts.join('\n')}
</svg>`;
}

export function renderSectionCard(card) {
  const key = `section|${createHash('sha1').update(JSON.stringify([CARD_RENDER_VERSION, town.id, card.kicker, card.title, card.lines, card.photo ? card.photo.length : 0, card.photo ? card.photo.slice(-64) : ''])).digest('hex')}`;
  let png = cache.get(key);
  if (!png) {
    png = new Resvg(sectionCardSvg(card), {
      fitTo: { mode: 'original' },
      font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Nunito' }
    }).render().asPng();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, png);
  }
  return png;
}
