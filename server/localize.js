/* server/localize.js — Victoria's static pages, for another town.
 *
 * docs/index.html (the homepage template) and docs/submit.html are written
 * for Victoria: its name, domain, GA ID, "Victoria, TX", the pick name and
 * prices. They stay that way (they ARE Victoria's pages, and the admin
 * preview serves them raw). For any other town, localizeHtml() rewrites them
 * through one table of Victoria's literals and the town's values, specific
 * before general. For Victoria it returns the page untouched, so its bytes
 * can't change. tests/town_static.test.js checks a second town's homepage
 * and submit form carry none of Victoria's literals. Pages that load
 * docs/app.js also get window.__TOWN__ (timezone, city, pick name,
 * utm_source), which app.js reads instead of Victoria's defaults.
 */

import { town as currentTown, VICTORIA } from './town.js';

const GA_SNIPPET_RE = /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-52YHD3X3C2"><\/script>\n<script>window\.dataLayer[^\n]*<\/script>\n?/g;
const html = s => String(s).replace(/’/g, '&rsquo;');

function table(t) {
  const v = VICTORIA;
  return [
    ['https://www.thevic361.com', t.siteUrl],
    [v.siteNameHtml, t.siteNameHtml],
    [v.siteName, t.siteName],
    [v.domain, t.domain],
    [v.gaId, t.gaId],
    [v.cityStateLong, t.cityStateLong],
    [v.cityState, t.cityState],
    [html(v.pickName), html(t.pickName)],
    ['in the 361', t.areaCode ? `in the ${t.areaCode}` : `in ${t.city}`],
    ['(361) 555-0123', `(${t.areaCode || '555'}) 555-0123`],
    [/\bVictoria\b/g, t.city]
  ];
}

// What docs/app.js needs to know about the town (it defaults to Victoria's).
export function townScript(t = currentTown) {
  const data = { timezone: t.timezone, city: t.city, state: t.state, pickName: t.pickName, utmSource: t.utmSource, ...(t.dormant ? { dormant: true } : {}) };
  return `<script>window.__TOWN__=${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`;
}

export function localizeHtml(page, t = currentTown) {
  if (t.id === VICTORIA.id) return page;
  let out = String(page);
  out = out.replace(/<script src="\.\/app\.js"><\/script>/, m => townScript(t) + '\n  ' + m);
  if (!t.gaId) out = out.replace(GA_SNIPPET_RE, '');
  for (const [from, to] of table(t)) {
    out = typeof from === 'string' ? out.split(from).join(to) : out.replace(from, () => to);
  }
  return out;
}
