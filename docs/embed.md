# Embedding the player

Deploying an instance from scratch? See [AGENTS.md](../AGENTS.md) for the operator runbook.

Any playlist you mark public can be dropped into another site with two lines of HTML. No build step, no framework, no account for the listener.

```html
<script src="https://your-box/embed.js"></script>
<demo-locker-player playlist="PLAYLIST_ID"></demo-locker-player>
```

`your-box` is wherever you're self-hosting Demo Locker — the same origin that streams your audio. That's the whole trust model: the only third party involved is the box you already run.

## Install from npm

Building the page with a bundler or framework (Vite, Next, Astro, …)? The same component ships as [`@demo-locker/player`](https://www.npmjs.com/package/@demo-locker/player):

```js
import "@demo-locker/player";
```

```html
<demo-locker-player instance="https://your-box" playlist="PLAYLIST_ID"></demo-locker-player>
```

One difference from the script tag: **`instance` is required**. A script tag loaded from your box auto-detects its origin; an npm-bundled module can't, so you point it at the instance explicitly. TypeScript types are included, and the `DemoLockerPlayer` class is a named export.

## Attributes

| Attribute | Required | Description |
|---|---|---|
| `playlist` | yes | The playlist ID to load. Must belong to a playlist marked public. |
| `instance` | no | The origin to fetch metadata and audio from, e.g. `https://your-box`. Defaults to the origin the `<script src>` was loaded from, so if you're loading `embed.js` from the same box that hosts the playlist, you can omit it. Set it explicitly if you're loading the script from one origin and the playlist lives on another (rare — most people won't need this). |

Attributes are read once, when the element is connected to the page — the component has no `observedAttributes`, so changing `playlist` (or `instance`) on an already-connected element has no effect. Set the attribute before inserting the element, or remove and recreate the element if you need to switch playlists.

## Theming

The player ships with the same TUI look as the rest of Demo Locker — dark, monospace, no rounded corners. Every visual value is a `--dl-*` custom property, so you can override the whole look from your page's CSS without touching the component's internals:

```css
--dl-bg: #0d0d0d;          /* background */
--dl-fg: #d8d8d8;          /* text color */
--dl-accent: #5fd75f;      /* buttons, active track, seek thumb */
--dl-muted: #6b6b6b;       /* secondary text — durations, timestamps */
--dl-border: #2e2e2e;      /* dividers and outlines */
--dl-font: "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
--dl-font-size: 13px;
--dl-radius: 0;            /* corner radius */
--dl-padding: 12px;        /* internal spacing */
```

Set any of these on the element itself (or an ancestor, since custom properties inherit):

```css
demo-locker-player {
  --dl-accent: hotpink;
}
```

For changes that go past color and spacing — swapping out layout, hiding elements, adding your own decoration — the internal structure is exposed via `::part()`. The available parts: `header`, `artwork`, `title`, `transport`, `button`, `seek`, `time`, `tracklist`, `track`, `status`, `footer`.

```css
demo-locker-player::part(button) {
  border-radius: 4px;
}
```

There's no shadow-DOM escape hatch beyond variables and parts on purpose — it keeps the component's internals free to change without breaking embedders.

## Public API reference

The player is a thin client over a small, unauthenticated, read-only API mounted at `/public/v1/`. If you want something the player doesn't do, build against this directly — it's the SDK.

`GET /public/v1/playlists/:id`

```json
{
  "playlist": {
    "id": "…",
    "name": "…",
    "artworkUrl": "/public/v1/playlists/:id/artwork",
    "tracks": [
      { "id": "…", "title": "…", "duration": 187.4 }
    ]
  }
}
```

`artworkUrl` is `null` if the playlist has no artwork.

`GET /public/v1/playlists/:id/artwork`

Returns the artwork image directly (or 404 if there's none).

`GET /public/v1/tracks/:id/stream`

Range-capable audio stream — point an `<audio>` element's `src` straight at it. Supports `Range` requests the same way the private stream endpoint does.

A few rules that matter if you're building against this directly:

- **A playlist that isn't public and a playlist that doesn't exist return the same 404.** There's no way to distinguish "private" from "never existed" from the response. Don't build logic that depends on telling them apart.
- **CORS is wide open (`*`) across the whole API**, not just `/public/v1/*`. That's deliberate for the public endpoints — the whole point is that anyone's site can embed anyone's public playlist. The private API isn't protected by CORS at all; its protection is bearer-token / share-token auth, so an open CORS policy doesn't expose it to unauthenticated cross-origin reads.
- Metadata responses are cacheable (`Cache-Control: public, max-age=60`); the stream keeps its existing cache headers.

## Roll your own player

You don't need our component. The public API is the SDK: fetch `/public/v1/playlists/:id` for metadata, then point an `<audio>` tag at `/public/v1/tracks/:id/stream` for each track. That's the entire integration surface — build whatever UI you want on top of it.

On distribution: loading `/embed.js` from your own instance is the supported path today, and it's the one we recommend — the player version always matches your instance's API, so there's nothing to keep in sync. An npm package (`@demo-locker/player`) for build-time bundling is planned but not shipped yet. If you end up loading the script from a CDN in the meantime, pin an exact version and use Subresource Integrity (SRI) — don't point at a floating `latest`. Note: on the hosted Worker deployment, `/embed.js` is served by Cloudflare's asset layer rather than the Hono route, so headers may differ slightly from a self-hosted instance.

Running `wrangler deploy` locally requires a player build to exist first (the Worker serves `/embed.js` from the built assets); `packages/api`'s `deploy` script now runs the player build before `wrangler deploy` so this is handled automatically.
