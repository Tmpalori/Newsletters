# The Crane 308: brand starter kit

Starter assets for **The Crane 308**. They are drawn in the same cartoon family as The Vic 361 (ink outlines, sticker colors, Fredoka lettering), with this town's own palette and motifs. Every file in `public/` overrides Victoria's copy in `docs/` through `townAssetPath()` and the static overlay.

## Concept

A sandhill crane in flight (slate gray, red crown) across open sky, with a golden sun setting low on the right over prairie gold, after the city mark. The sun stays clear of the bird so its outline reads at header size. The favicon is the crane's head (red crown, long bill) against the sun, which stays readable at 16 to 32px. The skyline sits on a red-brick street: a spheroid water tower marked 308, a concrete grain elevator, brick Central Avenue storefronts, the World Theatre (the four-story tan-brick Masonic Temple building at 2318 Central Avenue, with its red marquee and WORLD letters), a two-story brick block, and a V of cranes passing the sun. Out of town: cranes standing in the Platte shallows, a farm windmill, prairie tufts, and the Archway spanning the interstate (as a motif only). The red is the accent and the gold is the paid label, so UNK blue and gold never lead.

Header wordmark (two-tone, for `siteNameHtml` in town.json): `The Crane <span>308</span>`. The span is the tilted badge, filled with the `highlight` color.

## Palette

```json
{
  "primary": "#3D5670",
  "accent": "#C8323C",
  "paper": "#FBF4E4",
  "ink": "#232A35",
  "highlight": "#F4B63A"
}
```

| Role | Light | Dark mode | Use |
|---|---|---|---|
| primary | `#3D5670` | `#A8C0D8` | links, buttons, title accent |
| accent | `#C8323C` | `#FF6B70` | hover underline, secondary highlights |
| paper | `#FBF4E4` | `#161B23` (bg), `#212833` (surface) | page background |
| ink | `#232A35` | `#07090D` (outlines/shadows), `#F3F5F8` (text) | text, outlines, offset shadows |
| highlight | `#F4B63A` | `#F7C453` | the paid label ("Crane Pick"), title badge, hero marker |

Dark-mode JSON:

```json
{
  "primary": "#A8C0D8",
  "accent": "#FF6B70",
  "paper": "#161B23",
  "surface": "#212833",
  "ink": "#07090D",
  "text": "#F3F5F8",
  "highlight": "#F7C453"
}
```

Contrast: primary on paper is at least 4.5:1, ink on highlight is at least 7:1, and the dark-mode primary on its background is at least 7:1.

Illustration colors (skyline and logo only):

- crane slate #7A8B99 / dark #5A6B79 / light #B4C2CD
- crown red #C8323C
- sun gold #FFCF4D, prairie gold #F4B63A / deep #E09A2C
- sky #A6DAF4, prairie #C5D98A, grass #7FA650
- brick #B85A3E / light #D9805F, concrete #E3DCCB, Archway browns #9C6B48 / #B98258

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
