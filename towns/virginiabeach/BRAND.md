# The Tide 757: brand starter kit

Starter assets for **The Tide 757**. They are drawn in the same cartoon family as The Vic 361 (ink outlines, sticker colors, Fredoka lettering), with this town's own palette and motifs. Every file in `public/` overrides Victoria's copy in `docs/` through `townAssetPath()` and the static overlay.

## Concept

"Tide" is the Atlantic and the bay. The mark is a cresting Atlantic-blue wave curling over a gold sun rising on the horizon, since Virginia Beach is where the sun comes up out of the ocean. The wave rises from the sea line, so nothing but water meets the ring, and the curl and sun stay readable at header size. The favicon is the same wave and sun, simplified and bolder, which holds up at 16 to 32px. The skyline runs along the oceanfront: the Old Cape Henry Lighthouse (the 1792 octagonal sandstone tower) beside the New Cape Henry Lighthouse (cast iron, black and white faces that swap halfway up), sea oats on the dunes, boardwalk hotels with balconies, a surf shop, the bronze King Neptune statue at 31st Street (crowned and bearded, trident raised, rising from a mound of sea creatures: a loggerhead, a dolphin and octopus curls), and the Fishing Pier on its pilings with the pier house at the boardwalk end, lamp posts and someone fishing off the end. Brown pelicans glide overhead. Out of town: a dune fence, a lifeguard stand with a coral umbrella, a pelican on a post, and dolphins rolling offshore. At night the new Cape Henry light sweeps the sky, the windows and pier lamps glow, and a crescent moon replaces the sun. Coral is the accent and gold is the paid label, so no team or tourism-bureau colors lead.

Header wordmark (two-tone, for `siteNameHtml` in town.json): `The Tide <span>757</span>`. The span is the tilted badge, filled with the `highlight` color.

## Palette

```json
{
  "primary": "#0F5C8C",
  "accent": "#CC4A3C",
  "paper": "#FAF1DE",
  "ink": "#13263A",
  "highlight": "#F6B93B"
}
```

| Role | Light | Dark mode | Use |
|---|---|---|---|
| primary | `#0F5C8C` | `#8CC6EC` | links, buttons, title accent |
| accent | `#CC4A3C` | `#FF8A78` | hover underline, secondary highlights |
| paper | `#FAF1DE` | `#0F1A25` (bg), `#192736` (surface) | page background |
| ink | `#13263A` | `#050A10` (outlines/shadows), `#F1F5F9` (text) | text, outlines, offset shadows |
| highlight | `#F6B93B` | `#F8C955` | the paid label ("Tide Pick"), title badge, hero marker |

Dark-mode JSON:

```json
{
  "primary": "#8CC6EC",
  "accent": "#FF8A78",
  "paper": "#0F1A25",
  "surface": "#192736",
  "ink": "#050A10",
  "text": "#F1F5F9",
  "highlight": "#F8C955"
}
```

Contrast: primary on paper is 6.4:1, ink on highlight is 8.7:1, and the dark-mode primary on its background is 9.5:1 (8.2:1 on the surface).

Illustration colors (skyline and logo only):

- Atlantic blue #2E86AB / deep #1F6E96, sky #BFE6F2, foam #FFFFFF
- sunrise gold #FFC94A, coral #E8705F
- dune sand #F0DCA8, wet sand #F6E6BF, sea oats #7FA650 with seed heads #D9A84A
- Cape Henry sandstone #E3CBA0, lantern iron #3A4654
- Neptune bronze #A0703F / dark #7A5232 / gilt #C99A50, pier wood #9C7A55 / #7E5F40
- pelican gray-brown #8A7F72, dolphin #6F8FA6, hotel sea glass #9FD3DD
- og and email sky tint #DDEFF6

## Files

| File | Size | Used by |
|---|---|---|
| `public/logo.svg` | 128 viewBox | share cards (`server/ogImage.js`, embedded as a data URI); it has no text, so it needs no fonts |
| `public/logo.png` | 96x96 | header logo, light theme (shown at 48 to 54px, clipped round) |
| `public/logo-dark.png` | 96x96 | header logo, dark theme (adds a paper-colored halo so the ink ring shows on a dark header) |
| `public/logo-512.png` | 512x512 | schema.org Organization `logo` (`server/seo.js`) |
| `public/favicon.svg` | 64 viewBox | `<link rel=icon>` (simplified mark) |
| `public/favicon-32.png` | 32x32 | PNG favicon fallback |
| `public/favicon.ico` | 16, 32, 48 | `/favicon.ico` requests |
| `public/apple-touch-icon.png` | 180x180 | iOS home screen (opaque, paper background) |
| `public/og-image.png` | 1200x630 | site-wide og:image / twitter:image |
| `public/skyline.svg` | viewBox -800 0 2800 260 | hero art and footer (day); the town sits in x 0 to 1200, with beach on either side |
| `public/skyline-night.svg` | same | hero art and footer (dark theme) |
| `public/email/skyline.png` | 1200x260 | newsletter header (`server/newsletter.js`) |

Not overridden, because they are shared and generic: `icons.svg` and the `email/*.png` category icons (food, music and the rest), plus `sample-logo.svg`. Victoria's `outdoors` icon is a cactus, which reads as Texan; a town could add its own `email/outdoors.png` (48x48) and a matching symbol later if that matters (a wave or a pelican would suit Virginia Beach).

## Notes

- None of the SVGs contain text, so they render the same in an `<img>`, in resvg share cards and in email, with no font loading. The og-image lettering is Fredoka Bold from `server/fonts/Fredoka-Bold.ttf`.
- The og-image follows Kearney's layout: sky-to-paper gradient, the 164px logo, "The Tide" with the tilted gold `757` badge, the "Things to do in Virginia Beach, VA this week" line with a gold marker, and the 0 to 1200 slice of the day skyline along the bottom (y 370 to 630). `email/skyline.png` is the same slice on the flat sky tint.
- The PNGs were rasterized from the SVGs with Playwright (Chromium), and the `.ico` was built from the 16, 32 and 48px renders.
