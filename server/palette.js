/* server/palette.js — A town's own colors over the shared stylesheet.
 *
 * docs/style.css is Victoria's (bluebonnet purple, sunset orange, cream).
 * Another town with a palette (town.palette, from its BRAND.md) gets the
 * same file with an override appended: the color variables for light, dark
 * and the system dark-mode fallback, plus the few rules that write a color
 * out instead of using a variable (the footer band, the night hero, the
 * squiggles). Served as /style.css and /submit.css on that town's service
 * (server/index.js), so no page template changes. Victoria never gets one.
 *
 * BRAND.md gives five roles (primary, accent, paper, ink, highlight) and
 * their dark twins; the hover, muted and light shades are mixed from them
 * the way Victoria's sit next to hers. The day colors (sky, pink, cactus,
 * lilac) are the shared cartoon family and stay.
 */

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const toHex = rgb => '#' + rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
// `a` moved toward `b` by t (0..1).
export function mix(a, b, t) {
  const [x, y] = [hex(a), hex(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
const rgba = (c, alpha) => `rgba(${hex(c).join(', ')}, ${alpha})`;
const WHITE = '#FFFFFF';
const BLACK = '#000000';

function lightVars(p) {
  return {
    '--color-bg': p.paper,
    '--color-surface-offset': mix(p.paper, p.highlight, 0.35),
    '--color-divider': mix(p.paper, p.ink, 0.14),
    '--color-border': p.ink,
    '--color-text': p.ink,
    '--color-text-muted': mix(p.ink, p.paper, 0.25),
    '--color-text-faint': mix(p.ink, p.paper, 0.35),
    '--color-primary': p.primary,
    '--color-primary-hover': mix(p.primary, BLACK, 0.15),
    '--color-primary-active': mix(p.primary, BLACK, 0.3),
    '--color-primary-light': mix(p.primary, WHITE, 0.87),
    '--color-accent': p.accent,
    '--color-accent-hover': mix(p.accent, BLACK, 0.1),
    '--ink': p.ink,
    '--dot': rgba(p.ink, 0.09),
    '--sun': p.highlight,
    '--sun-light': mix(p.highlight, WHITE, 0.75),
    '--sunset': p.accent
  };
}

function darkVars(p) {
  return {
    '--color-bg': p.paper,
    '--color-surface': p.surface,
    '--color-surface-2': mix(p.surface, p.text, 0.05),
    '--color-surface-offset': mix(p.surface, p.text, 0.05),
    '--color-divider': mix(p.surface, p.text, 0.15),
    '--color-border': p.ink,
    '--color-text': p.text,
    '--color-text-muted': mix(p.text, p.paper, 0.22),
    '--color-text-faint': mix(p.text, p.paper, 0.33),
    '--color-text-inverse': p.paper,
    '--color-primary': p.primary,
    '--color-primary-hover': mix(p.primary, WHITE, 0.15),
    '--color-primary-active': mix(p.primary, WHITE, 0.3),
    '--color-primary-light': mix(p.paper, p.primary, 0.25),
    '--color-accent': p.accent,
    '--color-accent-hover': mix(p.accent, WHITE, 0.15),
    '--ink': p.ink,
    '--sun': p.highlight,
    '--sun-light': mix(p.paper, p.highlight, 0.2),
    '--sunset': p.accent,
    '--card': p.surface
  };
}

const block = (selector, vars) => `${selector} {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`;

// The override for docs/style.css, or '' without a palette.
export function townStyleCss(t) {
  if (!t || !t.palette) return '';
  const { light, dark } = t.palette;
  // The footer is a dark band in both themes (Victoria's navy): the
  // town's primary taken toward its ink.
  const band = mix(light.primary, light.ink, 0.45);
  const bandText = mix(WHITE, light.primary, 0.12);
  const bandMuted = mix(WHITE, light.primary, 0.3);
  const night = `linear-gradient(180deg, ${mix(dark.paper, light.primary, 0.15)} 0%, ${mix(dark.paper, light.primary, 0.45)} 60%, ${mix(dark.paper, light.primary, 0.8)} 100%)`;
  const squiggle = c => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='10' viewBox='0 0 40 10'%3E%3Cpath d='M0 5 Q5 0 10 5 T20 5 T30 5 T40 5' fill='none' stroke='%23${c.slice(1)}' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E")`;
  const dot = c => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='12' viewBox='0 0 48 12'%3E%3Ccircle cx='24' cy='6' r='4' fill='%23${c.slice(1)}'/%3E%3C/svg%3E")`;
  return `
/* ─── ${t.siteName}'s palette (towns/${t.id}/BRAND.md, server/palette.js) ─── */
${block(':root, [data-theme="light"]', lightVars(light))}
${block('[data-theme="dark"]', darkVars(dark))}
@media (prefers-color-scheme: dark) {
${block(':root:not([data-theme])', darkVars(dark)).replace(/^/gm, '  ')}
}
.site-footer { background: ${band}; color: ${bandText}; --color-text: ${bandText}; --color-text-muted: ${bandMuted}; --color-text-faint: ${bandMuted}; }
.footer-section p, .footer-links a, .footer-bottom { color: ${bandMuted}; }
.site-footer .signup-form input[type="email"] { color: ${light.ink}; }
[data-theme="dark"] .hero { background: ${night}; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .hero { background: ${night}; } }
[data-theme="dark"] .hero-sub { color: ${dark.text}; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .hero-sub { color: ${dark.text}; } }
.section-heading { background-image: ${squiggle(light.accent)}; }
.section-sep { background-image: ${dot(light.primary)}; }
`;
}

// The override for docs/submit.css (its own variables, light only).
export function townSubmitCss(t) {
  if (!t || !t.palette) return '';
  const p = t.palette.light;
  return `
/* ─── ${t.siteName}'s palette (towns/${t.id}/BRAND.md, server/palette.js) ─── */
${block(':root', {
    '--submit-bg': p.paper,
    '--submit-border': p.ink,
    '--submit-text': p.ink,
    '--submit-muted': mix(p.ink, p.paper, 0.25),
    '--submit-primary': p.primary,
    '--submit-primary-hover': mix(p.primary, BLACK, 0.15),
    '--ink': p.ink
  })}
`;
}
