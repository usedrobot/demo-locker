# Demo Locker — logo mark

**Date:** 2026-07-31
**Scope:** Replace the app/site mark (favicon). The ASCII wordmark is out of scope and does not change.

## Problem

The mark shipped today is a purple (`#863bff`) lightning-bolt shape built from sixteen blurred ellipses under an alpha mask. It shares no color, weight, or texture with the ASCII block wordmark it sits beside — different color family, different era, different construction. It reads as a leftover from another project.

Two secondary defects fall out of the same audit:

1. `packages/web/public/manifest.json` references `/icon-192.png` and `/icon-512.png`. Neither file exists anywhere in the repo, so PWA installs get a broken icon.
2. `#863bff` appears nowhere else in the codebase — the bolt is its only use. Removing the bolt removes the color.

## The mark

A padlock whose body has a four-bar waveform knocked out of it as negative space. Says "private audio" without explanation, and is built the way the rest of the identity is built: flat, single-color, high-contrast, no gradients or filters.

Construction is two filled paths, not a stroke and not a mask:

- **Shackle** — a filled outline (arc ring segment with two legs), so no `stroke` attribute is involved and the shape survives any renderer that mishandles stroke scaling.
- **Body + waveform** — one path with `fill-rule="evenodd"`: a rounded rect subpath followed by four stadium subpaths that become holes.

Keeping them as two sibling paths (rather than one compound path) matters: they overlap by 0.5 units where the shackle legs meet the body, and under `evenodd` a single path would turn that overlap into a hole. As siblings they simply union.

Both paths take `fill="currentColor"`, so the app renders the mark in its amber accent `#fc0` and the marketing site inherits its hue-cycling `--accent` with no second file.

### `logo-mark.svg` — full mark

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="currentColor" role="img" aria-label="Demo Locker">
  <path d="M8.9 14V10a7.1 7.1 0 0 1 14.2 0v4h-3.2v-4a3.9 3.9 0 0 0-7.8 0v4z"/>
  <path fill-rule="evenodd" d="M6.9 13.5h18.2a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1-2.4 2.4H6.9a2.4 2.4 0 0 1-2.4-2.4V15.9a2.4 2.4 0 0 1 2.4-2.4ZM6.9 22.95v-2.4a1.3 1.3 0 0 1 2.6 0v2.4a1.3 1.3 0 0 1-2.6 0ZM12.1 25.45v-7.4a1.3 1.3 0 0 1 2.6 0v7.4a1.3 1.3 0 0 1-2.6 0ZM17.3 23.95v-4.4a1.3 1.3 0 0 1 2.6 0v4.4a1.3 1.3 0 0 1-2.6 0ZM22.5 22.25v-1a1.3 1.3 0 0 1 2.6 0v1a1.3 1.3 0 0 1-2.6 0Z"/>
</svg>
```

Geometry, for anyone regenerating it: 32×32 viewBox. Shackle centered at (16, 10), radius 5.5, effective weight 3.2, legs terminating at y=14 (buried 0.5 under the body, so their flat ends never show). Body 4.5→27.5 × 13.5→30, corner radius 2.4. Bars are 2.6 wide with fully-rounded ends, left edges at x = 6.9 / 12.1 / 17.3 / 22.5, heights 5 / 10 / 7 / 3.6, all centered on y=21.75.

### Companion for 16px

Four 2.6-unit bars render at roughly 1.3 device pixels in a 16px favicon and blur into a stripe. The companion keeps the identical silhouette, shackle, and body but carries three 3.6-unit bars — heights 6 / 12 / 8, preserving the full mark's low–tall–mid contour. It is used **only** at favicon size; anywhere with room gets the full mark.

```svg
<path d="M8.8 14V10a7.2 7.2 0 0 1 14.4 0v4h-3.4v-4a3.8 3.8 0 0 0-7.6 0v4z"/>
<path fill-rule="evenodd" d="M6.4 13.5h19.2a2.4 2.4 0 0 1 2.4 2.4v11.7a2.4 2.4 0 0 1-2.4 2.4H6.4a2.4 2.4 0 0 1-2.4-2.4V15.9a2.4 2.4 0 0 1 2.4-2.4ZM7.6 22.95v-2.4a1.8 1.8 0 0 1 3.6 0v2.4a1.8 1.8 0 0 1-3.6 0ZM14.2 25.95v-8.4a1.8 1.8 0 0 1 3.6 0v8.4a1.8 1.8 0 0 1-3.6 0ZM20.8 23.95v-4.4a1.8 1.8 0 0 1 3.6 0v4.4a1.8 1.8 0 0 1-3.6 0Z"/>
```

### Plate

The favicon and PWA icons sit on a `#0a0a0a` rounded square, radius 8 in a 40×40 viewBox, with the mark inset 4 units and filled `#fc0`.

The plate exists because a favicon cannot use `currentColor` — it has no inheriting context, so it needs one committed color, and amber on a light tab bar is too low-contrast to read. The plate guarantees contrast in either tab bar and gives the PWA icon a shape to fill. It is not a new brand element: `#0a0a0a` is already `theme_color` in `manifest.json`.

In-app and README uses stay plate-less and inherit `currentColor`.

## Files

| File | Tracked | Action |
|---|---|---|
| `packages/web/public/favicon.svg` | yes | Replace — companion mark on plate |
| `site/favicon.svg` | yes | Replace — byte-identical to the above |
| `packages/web/public/logo-mark.svg` | new | Full mark, plate-less, `currentColor` |
| `packages/web/public/icon-192.png` | new | Full mark on plate, 192×192 |
| `packages/web/public/icon-512.png` | new | Full mark on plate, 512×512 |

The two favicons were already byte-identical and stay that way.

No React component is added and no in-app call site changes. The app currently renders only the ASCII wordmark, and introducing a `LogoMark` component nothing imports would be dead code. `logo-mark.svg` earns its place as the source the two PNGs are rendered from, and as the plate-less asset available for embeds, social, and docs. If the app later grows a header that wants the mark, it inlines this file then.

Untouched because they regenerate: `packages/web/dist/` is gitignored, and `packages/cli/assets/` is untracked and rebuilt by `packages/cli/scripts/build-assets.sh`, which copies the web build output. Both pick up the new mark on the next build with no manual step.

`packages/web/src/components/Logo.tsx` and `logo-art.ts` are the ASCII wordmark and are not touched.

## PNG generation

`sharp` resolves in the repo already. The PNGs are generated once from the plated SVG and committed, so no build step or toolchain dependency is added — regeneration is a manual step only if the mark changes.

## Verification

- Render `favicon.svg` at exactly 16px against both `#2a2a2c` and `#fff`; three bars must remain individually countable.
- Confirm `logo-mark.svg` carries no hard-coded fill: dropped into a page with an amber-colored parent it must render amber, and green under the site's `--accent`.
- `grep -rn '863bff' .` excluding `node_modules`/`dist` returns nothing.
- `manifest.json`'s two icon paths both resolve to real files.
- Build the CLI assets and confirm `packages/cli/assets/public/favicon.svg` matches the new source.

## Explicitly out of scope

The ASCII wordmark, the `--accent` colors themselves, any change to the site layout, and an `apple-touch-icon` (no current reference to one).
