# Self-Hosting Demo Locker

Deploying via an agent, or just want the fast path? See [AGENTS.md](../AGENTS.md) for the operator runbook.

This page covers the build-from-source path — running the API and web
services from source via Docker Compose, meant for production deployments
or local development where you want full control over each piece. The
database is always an embedded SQLite file; storage can be local disk or
any S3-compatible bucket. If you just want your music online without
building from source, use the standalone image and see
[Host Your Music](host-your-music.md) instead.

## Requirements

- **Docker** + **Docker Compose** (recommended)
- Or: Node 22+ and (optionally) an S3-compatible bucket

No media tooling is required on the server. Uploads are encoded to a 256 kbps
AAC streaming rendition in the browser, at upload time; the server just stores
what it is given (and keeps the original untouched).

## Quick Start (Docker)

```bash
git clone https://github.com/usedrobot/demo-locker.git
cd demo-locker
cp .env.example .env
docker compose up
```

That's it. Frontend at `:5173`, API at `:3001`.

> **Upgrading from before the SQLite millisecond-timestamp change?** If you
> ran an earlier build of this project against the same `data` volume (or
> `packages/api/data/*.db` in a manual setup), its timestamps are stored in
> **seconds**, but the schema now reads them as **milliseconds** — every date
> in the app will render around 1970. Don't try to patch the old database:
> delete it before upgrading. Docker Compose: `docker compose down -v` (removes
> the `data` volume). Manual setup: delete `packages/api/data/*.db`. A fresh
> database will be created and migrated automatically on next start.

### Serving beyond localhost

The `web` service's static build bakes in `VITE_API_URL` at build time (it's a
client-side bundle, not a runtime server), so if you're serving the frontend
to anything other than the machine running Docker, set `VITE_API_URL` in
`.env` to your API's reachable address (e.g. `http://YOUR-HOST:3001` or a
public URL) *before* running `docker compose build`. Otherwise every API
call from the built app will target `http://localhost:3001`, which only
works from the host machine itself.

Docker Compose includes:
- **MinIO** — local S3-compatible storage (stands in for Cloudflare R2)
- **API** — Hono backend
- **Web** — React frontend served via nginx

The database needs no separate service — it's an embedded SQLite file the
API creates automatically at `DATA_DIR/db/demolocker.db`.

## Manual Setup (No Docker)

### 1. Storage

Point `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_BUCKET` at any S3-compatible service:

| Service | Endpoint example |
|---|---|
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` |
| AWS S3 | `https://s3.<region>.amazonaws.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| MinIO (local) | `http://localhost:9000` |

Create a bucket named `demos` (or whatever you set `S3_BUCKET` to).

### 2. Environment

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

```env
PORT=3001
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=demos
S3_ACCESS_KEY=your-key
S3_SECRET_KEY=your-secret
S3_REGION=auto
```

### Access and quota settings

All optional. The defaults are the safe ones — you only need these to loosen
something or to tighten a quota.

| Variable | Default | What it does |
|---|---|---|
| `ALLOW_SIGNUP` | unset (closed) | **Registration closes automatically once the instance has one account.** The install wizard's first signup is what claims the locker; after that, `POST /auth/signup` returns 403. Set to `true` only if you want a shared instance where anyone can register. Collaborators normally arrive by share link and need no account at all. |
| `MAX_UPLOAD_BYTES` | `1073741824` (1GB) | Largest single file accepted by `POST /tracks/upload`. |
| `MAX_STORAGE_BYTES` | unset (unlimited) | Total stored bytes per account. Uploads that would cross it are rejected with 413. |
| `MAX_PLAYLISTS` | unset (unlimited) | Playlists per account. |
| `MAX_COLLABORATORS` | unset (unlimited) | Collaborators per locker — people who sign in and share your library. Counts invites you have minted but nobody has redeemed yet, so an unredeemed invite holds a seat until you revoke it. |
| `MAX_SHARE_LINKS` | unset (unlimited) | Share links per playlist. **Before 0.2.13 this ceiling was controlled by `MAX_COLLABORATORS`** — if you set that variable to limit share links, move the value here. |

`/auth/login` and `/auth/signup` are rate limited per client IP (10 logins per
15 minutes, 5 signups per hour) and answer 429 with `Retry-After` past that.
Behind a reverse proxy, make sure it sets `X-Forwarded-For` — without it, and
without Cloudflare's `CF-Connecting-IP`, every caller shares one bucket.

### 3. Run

```bash
# install deps
npm install

# start API
npm run dev -w packages/api

# start frontend (separate terminal)
npm run dev -w packages/web
```

## Storage Costs

Audio files are large. Rough estimates for S3-compatible storage:

| Tier | ~Files | Storage | Monthly cost (R2) |
|---|---|---|---|
| Solo artist | 50 tracks | ~2 GB | ~$0.03 |
| Small band | 200 tracks | ~10 GB | ~$0.15 |
| Heavy use | 1000 tracks | ~50 GB | ~$0.75 |

Cloudflare R2 has zero egress fees, so streaming costs nothing extra.

## Updating

```bash
git pull
npm install
docker compose up --build
```

Migrations run automatically on API start.

> **Coming from before the SQLite millisecond-timestamp change?** See the
> warning under Quick Start above — delete your old database (`docker compose
> down -v` or `packages/api/data/*.db`) before upgrading, don't try to patch it.

## Backups

The database is an embedded SQLite file at `DATA_DIR/db/demolocker.db` — backing up your locker means copying the data directory. Where that directory lives depends on how you're running it:

- **This Docker Compose setup:** the data directory is the `data` named volume defined in `docker-compose.yml`. Find its full (project-prefixed) name with `docker volume ls | grep _data`, then:

  ```bash
  docker run --rm -v <project>_data:/data -v $(pwd):/backup alpine tar czf /backup/demolocker-backup.tar.gz /data
  ```

- **Standalone image** (`docker run -v demolocker:/data ...`, see the main [README](../README.md)): back up the `demolocker` volume the same way — see [Host Your Music](host-your-music.md#backing-up) for the full command.
- **Manual (no Docker) setup:** copy `$DATA_DIR` directly:

  ```bash
  cp -r $DATA_DIR ./backup
  ```

If you're using S3-compatible storage instead of local disk, back up your S3 bucket too — it has the actual audio files.
