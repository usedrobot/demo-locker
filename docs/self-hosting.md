# Self-Hosting Demo Locker

## Requirements

- **Docker** + **Docker Compose** (recommended)
- Or: Node 22+, PostgreSQL 16+, FFmpeg, and an S3-compatible bucket

## Quick Start (Docker)

```bash
git clone https://github.com/fldl/demo-locker.git
cd demo-locker
cp .env.example .env
docker compose up
```

That's it. Frontend at `:5173`, API at `:3001`.

Docker Compose includes:
- **Postgres** — database
- **MinIO** — local S3-compatible storage (stands in for Cloudflare R2)
- **API** — Hono backend
- **Web** — React frontend served via nginx

## Manual Setup (No Docker)

### 1. Database

Set up a Postgres instance and create a database:

```sql
CREATE DATABASE demolocker;
```

Run migrations:

```bash
cd packages/api
DATABASE_URL=postgres://user:pass@localhost:5432/demolocker npx drizzle-kit migrate
```

### 2. Storage

Point `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_BUCKET` at any S3-compatible service:

| Service | Endpoint example |
|---|---|
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` |
| AWS S3 | `https://s3.<region>.amazonaws.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| MinIO (local) | `http://localhost:9000` |

Create a bucket named `demos` (or whatever you set `S3_BUCKET` to).

### 3. FFmpeg

FFmpeg must be installed and on the PATH. It's used for transcoding uploads.

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
apt install ffmpeg

# Alpine (Docker)
apk add ffmpeg
```

### 4. audiowaveform (Optional)

For waveform generation. If not installed, tracks will work without waveforms.

```bash
# macOS
brew install audiowaveform

# Ubuntu — build from source
# https://github.com/bbc/audiowaveform
```

### 5. Environment

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

```env
DATABASE_URL=postgres://user:pass@localhost:5432/demolocker
PORT=3001
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=demos
S3_ACCESS_KEY=your-key
S3_SECRET_KEY=your-secret
S3_REGION=auto
```

### 6. Run

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

## Backups

Back up Postgres and your S3 bucket. The database is small (metadata only). The S3 bucket has the actual audio files.

```bash
pg_dump demolocker > backup.sql
```
