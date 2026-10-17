# The Star 402: brand starter kit

Starter assets for **The Star 402** (thestar402.com). They are drawn in the same cartoon family as The Vic 361 (ink outlines, sticker colors, Fredoka lettering), with this town's own palette and motifs. Every file in `public/` overrides Victoria's copy in `docs/` through `townAssetPath()` and the static overlay.

## Concept

"Star" is for Lincoln's nickname, the Star City. The mark is a bold golden five-point star on a deep prairie-indigo night sky over a band of wheat, with the Nebraska State Capitol tower standing as a quiet navy silhouette (gold dome, The Sower on top) to the right. The star stays clear of the ring and of the tower, so it reads on its own at 48px. The favicon is the star alone in the ring, which stays readable at 16 to 32px.

The skyline sits on a Haymarket brick street. In town (x 0 to 1200): a concrete grain elevator by the rail yard with a 402 sign on the headhouse, Pinnacle Bank Arena's sweeping curved roof over its glass front, two Haymarket brick warehouses (one with a painted HAYMARKET sign), the Nebraska State Capitol as the centerpiece (limestone base and entrance pavilion, the tall tower, the colonnaded drum, the golden dome and The Sower), Lincoln Station (the 1927 Burlington depot, with its columned front and sign), a brick storefront and a cream mid-rise. Out of town: a freight train of grain hoppers on the rail line, a barn and hay bales to the west, and a Memorial Stadium hint (brick arches, press box, light towers), trees and a windmill to the east. At night the sun becomes a crescent moon, the windows light up, and one big gold star hangs over the Haymarket. It is locals-first: no team marks, and Husker scarlet never leads; the warm accent is Haymarket brick.

Header wordmark (two-tone, for `siteNameHtml` in town.json): `The Star <span>402</span>`. The span is the tilted badge, filled with the `highlight` color.

## Palette

```json
{
  "primary": "#2F3B73",
  "accent": "#B04E32",
  "paper": "#FAF5E8",
  "ink": "#1F2433",
  "highlight": "#F5BE3C"
}
```

| Role | Light | Dark mode | Use |
|---|---|---|---|
| primary | `#2F3B73` | `#AEB8EE` | links, buttons, title accent |
| accent | `#B04E32` | `#FF8A66` | hover underline, secondary highlights |
| paper | `#FAF5E8` | `#14172A` (bg), `#1F2338` (surface) | page background |
| ink | `#1F2433` | `#06070D` (outlines/shadows), `#F3F4FA` (text) | text, outlines, offset shadows |
| highlight | `#F5BE3C` | `#F7C64F` | the paid label ("Featured"), title badge, hero marker |

Dark-mode JSON:

```json
{
  "primary": "#AEB8EE",
  "accent": "#FF8A66",
  "paper": "#14172A",
  "surface": "#1F2338",
  "ink": "#06070D",
  "text": "#F3F4FA",
  "highlight": "#F7C64F"
}
```

Contrast: primary on paper is 9.7:1, accent on paper is 4.8:1, ink on highlight is 9.1:1, and the dark-mode primary on its background is 9.2:1.

Illustration colors (skyline and logo only):

- logo sky indigo #33417E, Capitol silhouette #222B5F, star gold #FFC93C, star shine #FFF1C2
- Capitol limestone #E9DFC4 / shade #D2C29F, dome gold #F2B53A / tile lines #C98A1E, The Sower bronze #5C4A32
- Haymarket brick #A9533A / light #C9734F / dark #8C4230, street mortar #D08C70
- wheat #E9B85C, Lincoln Station stone #EAD7AF, concrete #E3DCCB / #C9C1AE, arena tan #D9C6A1
- sky glass #A9D3EE, prairie #CBD892, grass #7C9F4E, sun #FFCF4D, night windows and moon #FFE08A

## Files

| File | Size | Used by |
|---|---|---|
| `public/logo.svg` | 128 viewBox | share cards (`server/ogImage.js`, embedded as a data URI); no text, so it needs no fonts |
| `public/logo.png` | 96x96 | header logo, light theme (shown at 48 to 54px, clipped round) |
| `public/logo-dark.png` | 96x96 | header logo, dark theme (adds a paper-colored halo so the ink ring shows on a dark header) |
| `public/logo-512.png` | 512x512 | schema.org Organization `logo` (`server/seo.js`) |
| `public/favicon.svg` | 64 viewBox | `<link rel=icon>` (simplified mark: the star alone) |
| `public/favicon-32.png` | 32x32 | PNG favicon fallback |
| `public/favicon.ico` | 16, 32, 48 | `/favicon.ico` requests |
| `public/apple-touch-icon.png` | 180x180 | iOS home screen (opaque, paper background) |
| `public/og-image.png` | 1200x630 | site-wide og:image / twitter:image |
| `public/skyline.svg` | viewBox -800 0 2800 260 | hero art and footer (day); the town sits in x 0 to 1200, with countryside on either side |
| `public/skyline-night.svg` | same | hero art and footer (dark theme) |
| `public/email/skyline.png` | 1200x260 | newsletter header (`server/newsletter.js`) |

Not overridden, because they are shared and generic: `icons.svg` and the `email/*.png` category icons (food, music and the rest), plus `sample-logo.svg`. Victoria's `outdoors` icon is a cactus, which reads as Texan; a town could add its own `email/outdoors.png` (48x48) and a matching symbol later if that matters.

## Notes

- Lettering in every SVG (402, HAYMARKET and LINCOLN STATION in the skylines) is outlined to paths from `server/fonts/Fredoka-Bold.ttf`, so it renders the same in an `<img>`, in resvg share cards and in email, with no font loading.
- The PNGs were rasterized from the SVGs with Playwright (Chromium), and the `.ico` was built from the 16, 32 and 48px renders. The og-image follows Kearney's layout: logo at left, "The Star" with the tilted 402 badge, the "Things to do in Lincoln, NE this week" line with "Lincoln, NE" highlighted, and the day skyline along the bottom 260px.
