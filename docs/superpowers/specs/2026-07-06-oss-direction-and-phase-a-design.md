# Demo Locker — OSS Direction & Phase A Design

**Date:** 2026-07-06
**Status:** Approved by DL (pending spec review)

## Product direction

Demo Locker is two products built from one codebase:

1. **OSS (`usedrobot/demo-locker`, public, MIT)** — the self-hostable product. Two surfaces:
   - The existing **private demo locker**: upload rough mixes, playlists, back-to-back playback, timestamped comments, invite-link sharing.
   - A new **public player** (Phase B): playlists can be marked public, exposed via a read-only public API, and embedded on any website via a web component (`<demo-locker-player playlist="...">`) with a single script tag. The public API doubles as the de-facto SDK for anyone who wants to build a custom player. OSS ships one default theme (the TUI look) and the component is fully themeable via CSS variables/slots.
2. **Cloud (`usedrobot/demo-locker-cloud`, private fork)** — the hosted SaaS: hosting, accounts, billing, admin, and the **premium theme pack** (minimal, Winamp-style, Spotify-like, etc.). Themes beyond the default are a hosted-plan perk; community themes on OSS remain possible and welcome.

**Why:** streaming platforms own artists' distribution. An artist should be able to self-host high-quality streaming audio on their own site — and share private works-in-progress with bandmates — without depending on a platform. The OSS zero-dependency mode serves the tinkerer at $0; the hosted product serves everyone who doesn't want to run a server. The gap between them is the business model, not a flaw.

## Sequencing

- **Phase A — OSS hardening:** zero-dependency mode + all-in-one image + deploy templates + beginner hosting guide. *(This spec.)*
- **Phase B — Public player:** public read-only API + embeddable web component + default TUI theme. *(Own spec later.)*
- **Phase C — Cloud:** stand up the private fork, billing, premium theme pack. *(Own spec later.)*

Each phase ships something usable on its own.

## Phase A — "one box is the whole stack"

### Goal

A motivated beginner (the target persona is a teenager with an old laptop) can get Demo Locker running on the public internet with one container and zero third-party service accounts. Success: `docker run` with a single volume produces a fully working install — uploads, transcoding, playback, comments — with no Postgres server and no S3 bucket.

### 1. Zero-dependency mode, selected by absence of config

No mode flag. The server picks drivers based on which env vars are present:

- **Database:** if `DATABASE_URL` is unset, use **PGlite** (embedded Postgres, WASM) persisting to `./data/db`. Drizzle's PGlite driver speaks the same Postgres dialect as Neon/node-postgres, so there is **one schema and one migration set** across zero-dep, self-hosted-Postgres, and cloud. Migrations run automatically on boot in PGlite mode.
- **Storage:** if S3 credentials are unset, use a new **`storage-fs.ts`** driver implementing the existing `StorageBucket` interface (`put`/`get`/`delete`, including range reads) against `./data/audio`. Range support means scrub/seek works unchanged. Keys map to file paths under the root; path traversal in keys is rejected.

Setting the env vars puts you back on Postgres + S3 with the same code. Existing deployments are unaffected.

**Constraints (documented, not engineered around):** PGlite is single-connection/single-process — fine for a single-instance install, which is the only thing zero-dep mode targets. Horizontal scaling means graduating to Postgres + S3.

### 2. All-in-one Docker image

One image containing:

- Node + Hono API (the existing Node deploy target)
- The built web frontend, served statically by the same Hono server (no separate frontend container)
- ffmpeg bundled for transcoding
- Single volume at `/data` holding both the PGlite database and audio files

Quick start becomes:

```bash
docker run -v demolocker:/data -p 3001:3001 usedrobot/demo-locker
```

Image published to a public registry (GHCR) by CI on release. The existing multi-container `docker-compose.yml` remains for the Postgres + S3 path.

### 3. Deploy templates

- **Fly.io** template (`fly.toml`, volume-backed)
- **Railway** template (volume-backed)
- **Coolify** documented path

Templates use the all-in-one image. Free-tier caveats (volume persistence, sleep behavior) documented honestly.

### 4. "Host your music" guide

A beginner-aimed doc (`docs/host-your-music.md`) covering the three real hosting paths, written for a motivated teenager, not a devops person:

1. **$0 — home hosting:** old laptop or Raspberry Pi + Cloudflare Tunnel (free HTTPS + public URL through a home router).
2. **$4–6/mo — VPS:** Hetzner/DigitalOcean, one `docker run`.
3. **PaaS:** the Fly/Railway templates, with free-tier caveats.

Includes the honest bandwidth note: home connections and cheap VPSes are fine for demo sharing and modest band-site traffic; a popular band will outgrow them (and that's the upgrade path — bigger box or the hosted product).

### Error handling

- Boot logs state plainly which mode each driver is in (e.g. `db: pglite (./data/db) — set DATABASE_URL to use Postgres`).
- Missing/unwritable `/data` fails fast at boot with a clear message, not at first upload.
- Mixed configuration (e.g. `DATABASE_URL` set but no S3 creds) is valid — drivers select independently.

### Testing

- Existing API test suite runs against PGlite in CI (drops the Postgres service container requirement).
- Unit tests for `storage-fs.ts` including range reads and path-traversal rejection.
- Smoke test in CI: boot the all-in-one image, sign up, upload a track, transcode, stream a byte range, post a comment.

### Out of scope for Phase A

- Anything public-facing (public API, embed player, themes) — Phase B.
- Cloud fork, billing — Phase C.
- Schema changes of any kind.
- SQLite support (rejected: permanent two-dialect schema tax; PGlite keeps one Postgres dialect everywhere).
