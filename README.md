# demo locker

Private demos. Sequenced. Commented. Yours.

A web app for sharing and sequencing unfinished music demos. Upload rough mixes, arrange them into playlists, listen back-to-back, and leave timestamped comments.

## Quick Start

```bash
cp .env.example .env
docker compose up
```

API runs on `:3001`, frontend on `:5173`.

## Self-Host

```bash
git clone https://github.com/fldl/demo-locker.git
cp .env.example .env    # point at your own Postgres + S3 bucket
docker compose up
```

## Stack

- **Frontend**: React + Vite
- **Backend**: Hono
- **Database**: Postgres + Drizzle
- **Storage**: Cloudflare R2 (any S3-compatible)
- **Style**: TUI-in-the-browser. Monospace. Box-drawing. No images.

## License

MIT
