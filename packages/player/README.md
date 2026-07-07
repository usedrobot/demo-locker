# @demo-locker/player

Embeddable music player for your own website — the `<demo-locker-player>` web component from [Demo Locker](https://github.com/usedrobot/demo-locker), the self-hosted music streaming and private demo sharing app. Zero dependencies, ~5 KB, themeable, framework-agnostic.

Works with any Demo Locker instance serving `/public/v1`.

## Install

```bash
npm install @demo-locker/player
```

```js
import "@demo-locker/player"; // registers <demo-locker-player>
```

```html
<demo-locker-player
  instance="https://your-box"
  playlist="PLAYLIST_ID"
></demo-locker-player>
```

**The `instance` attribute is required when installing from npm.** When the component is loaded as a script tag from a Demo Locker instance it auto-detects that origin; an npm-bundled module has no script origin, so you must point it at the box that hosts your playlist.

The `DemoLockerPlayer` class is a named export if you want manual registration or subclassing; `HTMLElementTagNameMap` is augmented, so `document.createElement("demo-locker-player")` is fully typed.

## No build step?

Load it straight off your instance instead — no npm needed:

```html
<script src="https://your-box/embed.js"></script>
<demo-locker-player playlist="PLAYLIST_ID"></demo-locker-player>
```

(Or from a CDN: `https://unpkg.com/@demo-locker/player/dist/embed.js` — then `instance` is required, same as npm.)

## Attributes

| Attribute | Required | Description |
|---|---|---|
| `playlist` | yes | ID of a playlist marked public on the instance. |
| `instance` | npm/CDN: yes · instance script tag: no | Origin to fetch metadata and audio from, e.g. `https://your-box`. |

Attributes are read once, when the element is connected — there are no `observedAttributes`. Set attributes before inserting the element; to switch playlists, remove and recreate it.

## Theming

Every visual value is a `--dl-*` custom property (`--dl-bg`, `--dl-fg`, `--dl-accent`, `--dl-muted`, `--dl-border`, `--dl-font`, `--dl-font-size`, `--dl-radius`, `--dl-padding`):

```css
demo-locker-player {
  --dl-accent: hotpink;
}
```

Structural nodes are exposed via `::part()` — `header`, `artwork`, `title`, `transport`, `button`, `seek`, `time`, `tracklist`, `track`, `status`, `footer`. Full theming docs: [docs/embed.md](https://github.com/usedrobot/demo-locker/blob/main/docs/embed.md).

## Versioning

Independent semver. The compatibility contract is the instance's `/public/v1` API; a hypothetical `/public/v2` target would be a major bump here.

## Releasing (maintainers)

Bump `version` in `packages/player/package.json`, commit to main, then:

```bash
git tag player-vX.Y.Z && git push origin player-vX.Y.Z
```

CI publishes with provenance via npm trusted publishing — no tokens.

## License

MIT
