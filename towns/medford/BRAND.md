# The Rogue 541: brand starter kit

Starter assets for **The Rogue 541**. They are drawn in the same cartoon family as The Vic 361 (ink outlines, sticker colors, Fredoka lettering), with this town's own palette and motifs. Every file in `public/` overrides Victoria's copy in `docs/` through `townAssetPath()` and the static overlay.

## Concept

Mt. McLoughlin (a snow-capped cone) over fir-green foothills and a teal river, with a pear-gold sun. The skyline puts the mountain behind the right side of downtown: the Hotel Medford (the tallest building downtown, brick with broad eaves and its HOTEL MEDFORD rooftop sign), the Holly Theatre (brick, red tile roof, arched storefronts and its tall HOLLY blade sign), awninged storefronts and pear trees. The Rogue River runs teal along the bottom. Out of town: vineyard rows with plum grapes on one side and a pear orchard on the other, with firs throughout. No flames, smoke or Table Rock.

Header wordmark (two-tone, for `siteNameHtml` in town.json): `The Rogue <span>541</span>`. The span is the tilted badge, filled with the `highlight` color.

## Palette

```json
{
  "primary": "#137A77",
  "accent": "#7A2E66",
  "paper": "#F8F4E6",
  "ink": "#1D2633",
  "highlight": "#EBC74A"
}
```

| Role | Light | Dark mode | Use |
|---|---|---|---|
| primary | `#137A77` | `#62D3CC` | links, buttons, title accent |
| accent | `#7A2E66` | `#D88CC6` | hover underline, secondary highlights |
| paper | `#F8F4E6` | `#10201F` (bg), `#1A2E2D` (surface) | page background |
| ink | `#1D2633` | `#050C0C` (outlines/shadows), `#EEF7F5` (text) | text, outlines, offset shadows |
| highlight | `#EBC74A` | `#F2D35E` | the paid label ("Spotlight"), title badge, hero marker |

Dark-mode JSON:

```json
{
  "primary": "#62D3CC",
  "accent": "#D88CC6",
  "paper": "#10201F",
  "surface": "#1A2E2D",
  "ink": "#050C0C",
  "text": "#EEF7F5",
  "highlight": "#F2D35E"
}
```

Contrast: primary on paper is at least 4.5:1, ink on highlight is at least 7:1, and the dark-mode primary on its background is at least 7:1.

Illustration colors (skyline and logo only):

- river teal #1E9A96 / deep #137A77 / light #86D6CF
- forest #2F6B3F, fir #24563A, hills #9FCF9A
- pear gold #EBC74A / light #F6DE85
- wine plum #7A2E66 / light #B66AA2
- mountain #7A8DB3, sky #C4E8EC, brick #C76B4E, cream #F8F2E2

## Files

| File | Size | Used by |
|---|---|---|
| `public/logo.svg` | 128 viewBox | share cards (`server/ogImage.js`, embedded as a data URI); text is converted to paths, so it needs no fonts |
| `public/logo.png` | 96x96 | header logo, light theme (shown at 48 to 54px, clipped round) |
| `public/logo-dark.png` | 96x96 | header logo, dark theme (adds a paper-colored halo so the ink ring shows on a dark header) |
| `public/logo-512.png` | 512x512 | schema.org Organization `logo` (`server/seo.js`) |
| `public/favicon.svg` | 64 viewBox | `<link rel=icon>` (simplified mark) |
| `public/favicon-32.png` | 32x32 | PNG favicon fallback |
| `public/favicon.ico` | 16, 32, 48 | `/favicon.ico` requests |
| `public/apple-touch-icon.png` | 180x180 | iOS home screen (opaque, paper background) |
| `public/og-image.png` | 1200x630 | site-wide og:image / twitter:image |
| `public/skyline.svg` | viewBox -800 0 2800 260 | hero art and footer (day); the town sits in x 0 to 1200, with countryside on either side |
| `public/skyline-night.svg` | same | hero art and footer (dark theme) |
| `public/email/skyline.png` | 1200x260 | newsletter header (`server/newsletter.js`) |

Not overridden, because they are shared and generic: `icons.svg` and the `email/*.png` category icons (food, music and the rest), plus `sample-logo.svg`. Victoria's `outdoors` icon is a cactus, which reads as Texan; a town could add its own `email/outdoors.png` (48x48) and a matching symbol later if that matters.

## Notes

- Lettering in every SVG (the sign and tank lettering in the skylines) is outlined to paths from `server/fonts/Fredoka-Bold.ttf`, so it renders the same in an `<img>`, in resvg share cards and in email, with no font loading.
- The PNGs were rasterized from the SVGs with Playwright (Chromium), and the `.ico` was built from the 16, 32 and 48px renders.
