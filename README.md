# demo locker

```
┌──────────────────────────────┐
│  demo locker                 │
│  ──────────────────────────  │
│  private demos. sequenced.   │
│  commented. yours.           │
└──────────────────────────────┘
```

A web app for sharing and sequencing unfinished music demos. Upload rough mixes, arrange them into playlists, listen back-to-back, and leave timestamped comments — from your phone on a morning walk.

**Open source. Self-hostable. MIT licensed.**

## Why

- **Dropbox** can't playlist demos or play them back-to-back. Stream quality is garbage.
- **SoundCloud** is too much platform. Too public. Too focused on getting you to be a content creator.
- **Demo Locker** is for works in progress. The audience is you, your band, and your collaborators — not the world.

## Features

- Upload WAV, AIFF, MP3, FLAC, M4A
- Arrange tracks into playlists, drag to reorder
- Back-to-back playback with auto-advance
- Timestamped comments on tracks (click the waveform)
- General comments on playlists
- Share via invite link — listen + comment without an account
- Edit-level sharing for collaborators who need to reorder/upload
- Mobile-first PWA with background audio and lock screen controls
- TUI aesthetic — monospace, box-drawing, dark mode only

## Quick Start

```bash
cp .env.example .env
docker compose up
```

Frontend at `localhost:5173`, API at `localhost:3001`.

## Self-Host

```bash
git clone https://github.com/usedrobot/demo-locker.git
cd demo-locker
cp .env.example .env    # point at your own Postgres + S3 bucket
docker compose up
```

Three commands. See [docs/self-hosting.md](docs/self-hosting.md) for the full guide.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite |
| Backend | Hono |
| Database | Postgres + Drizzle |
| Storage | Cloudflare R2 (any S3-compatible) |
| Transcoding | FFmpeg |
| Style | Vanilla CSS — TUI in the browser |

No axios. No Tailwind. No component library. Just the basics.

## Project Structure

```
demo-locker/
├── packages/
│   ├── api/          # Hono backend
│   │   └── src/
│   │       ├── routes/     # auth, playlists, tracks, comments, shares
│   │       ├── db/         # Drizzle schema + migrations
│   │       └── lib/        # auth, storage, transcoding
│   └── web/          # React frontend
│       └── src/
│           ├── components/ # Player, TrackList, Waveform, Comments, etc.
│           ├── pages/      # Login, Home, PlaylistView, Invite
│           └── lib/        # API client, audio engine
├── docs/
│   └── self-hosting.md
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## License

MIT — do whatever you want with it.
