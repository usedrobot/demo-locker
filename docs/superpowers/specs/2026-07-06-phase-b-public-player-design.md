# Demo Locker — Phase B: Public Player Design

**Date:** 2026-07-06
**Status:** Approved by DL (pending spec review)
**Builds on:** `2026-07-06-oss-direction-and-phase-a-design.md` (umbrella direction; Phase A shipped as PR #1)

## Goal

An artist self-hosting Demo Locker can mark a playlist public and put a player for it on any website with two lines of HTML. The public API underneath is the de-facto SDK for anyone who wants to build their own player.

## What "public" means

- Playlists get a `public` boolean column (default `false`). This is Phase B's only schema change, done via `drizzle-kit generate` (one migration).
- A public playlist exposes exactly: playlist name, artwork, track titles/durations/order, and audio streams.
- Never exposed publicly: comments, annotations, collaborator identities, invite links, owner email. These are demo-workflow features, not fan features.
- Stream-only. No download endpoint in Phase B.

## Public API

Unauthenticated, read-only, versioned under `/public/v1/`:

| Endpoint | Returns |
|---|---|
| `GET /public/v1/playlists/:id` | `{ playlist: { id, name, artworkUrl, tracks: [{ id, title, duration }] } }` |
| `GET /public/v1/playlists/:id/artwork` | artwork image (or 404) |
| `GET /public/v1/tracks/:id/stream` | range-capable audio stream (reuses the existing stream machinery; verifies the track's parent playlist is public) |

Rules:

- Anything not public returns **404, indistinguishable from nonexistent** — private content is not enumerable and its existence is not leakable.
- CORS is open (`*`) on `/public/v1/*` only; the private API's CORS behavior is unchanged.
- Hotlinking is accepted by design — it's open streaming. A future `ALLOWED_ORIGINS` env var can restrict embedding; documented as out of scope.
- Responses are cacheable (`Cache-Control: public, max-age=60` on metadata; streams keep existing cache headers).
- Works identically on both deploy targets (Worker and Node) — the routes live in the shared app.

## Embeddable player

- New workspace `packages/player`: a **framework-free vanilla web component**, `<demo-locker-player instance="https://your-box" playlist="<id>">`. If `instance` is omitted, it defaults to the origin the script was loaded from.
- Built as one self-contained IIFE bundle with zero runtime dependencies. The API server serves it at **`/embed.js`** — same origin as the streams, so the only party a band trusts is the box they already run. Player version always matches the instance API.
- The documented snippet:

```html
<script src="https://your-box/embed.js"></script>
<demo-locker-player playlist="PLAYLIST_ID"></demo-locker-player>
```

- Player UI (deliberately simpler than the private app): artwork, track list, play/pause/prev/next, seekable progress bar, current-time/duration, auto-advance. No waveform in v1.
- **Theming:** default TUI theme (the brand look). Every color, font, and spacing value is a `--dl-*` CSS custom property; structural elements carry `part=` attributes so embedders can restyle beyond variables. The premium theme pack remains a cloud-product perk per the umbrella spec.
- **Distribution:** instance-served `/embed.js` is the only Phase B path. npm publish (`@demo-locker/player`, 2FA + provenance, aimed at build-time bundling) is a fast-follow after Phase B. Raw CDN usage is never promoted as a first-class path; if ever documented, it is with SRI version pinning and a warning.

## Owner UX

In the private playlist view:

- `[make public]` / `[make private]` toggle (owner only).
- When public: a copy-paste embed snippet box and the public API URL, shown inline.
- Making a playlist private again takes effect immediately (public endpoints return 404; already-loaded players fail gracefully on the next request).

## Testing

- **Public/private boundary tests are the security-critical suite:** private playlist → 404 on all three public endpoints; public playlist → correct payload with no private fields; track whose parent playlist is private → stream 404; toggling public off revokes access.
- Component: smoke-level verification via the demo page (loads, lists tracks, plays) — no browser-test framework in Phase B.
- `scripts/smoke.sh` extends: mark the smoke playlist public → fetch `/public/v1/playlists/:id` without auth → stream a range without auth → `GET /embed.js` returns JS.

## Docs + demo

- `docs/embed.md`: the snippet, component attributes, `--dl-*` variable reference, public API reference (the SDK doc).
- A static demo band-site page in the repo at `docs/demo-site/index.html` that embeds a player — dogfooding and launch material.

## Out of scope for Phase B

- Downloads; public playlist pages hosted by the instance; additional themes; npm/CDN distribution; waveform in the public player; play counts/analytics; `ALLOWED_ORIGINS` embed restriction.
