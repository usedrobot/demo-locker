# demo locker

```
┌──────────────────────────────┐
│  demo locker                 │
│  ──────────────────────────  │
│  self-hosted music streaming │
│  private demos. embeds.      │
└──────────────────────────────┘
```

A web app for **self-hosted music streaming**: share and sequence unfinished demos with **private demo sharing**, or publish a playlist as an **embeddable music player for your own website**. Upload rough mixes, arrange them into playlists, listen back-to-back, leave timestamped comments — from your phone on a morning walk — or drop a public player on your band's site with two lines of HTML.

**Open source. Self-hostable. MIT licensed.**

## Why

- **Dropbox** can't playlist demos or play them back-to-back. Stream quality is garbage.
- **SoundCloud** is too much platform. Too public. Too focused on getting you to be a content creator.
- Streaming platforms own your distribution. Demo Locker means your music streams from a box you control.
- **Demo Locker** is for works in progress. The audience is you, your band, and your collaborators — not the world.

## Features

- Upload WAV, AIFF, MP3, FLAC, M4A
- Arrange tracks into playlists, drag to reorder
- Public player — mark a playlist public, embed it on any site with two lines, or `npm install @demo-locker/player` ([docs](docs/embed.md))
- Back-to-back playback with auto-advance
- Timestamped comments on tracks (click the waveform)
- General comments on playlists
- Share via invite link — listen + comment without an account
- Edit-level sharing for collaborators who need to reorder/upload
- Mobile-first PWA with background audio and lock screen controls
- TUI aesthetic — monospace, box-drawing, dark mode only

## Quick Start

**Setting this up with an AI agent?** Point it at [AGENTS.md](AGENTS.md) — a step-by-step runbook with verification for every step. Machine-readable map: [llms.txt](llms.txt). Running instances self-describe at /openapi.json.

### Fastest start

```bash
npx demo-locker
```

The wizard asks where you want it running — Cloudflare (Worker + D1 + R2) or
Docker on a machine you control — and takes it from there. Manual paths below.

One container, zero external services — database and audio files live in a single volume:

```bash
docker run -d -v demolocker:/data -p 3001:3001 ghcr.io/usedrobot/demo-locker:latest
```

Open `http://localhost:3001`. That's the whole stack.

For development, or to build from source with your own S3-compatible storage, see below.

## Self-Host

New to hosting? Start with [Host Your Music](docs/host-your-music.md) — the beginner guide.

The build-from-source path, for production deployments or local development:

```bash
git clone https://github.com/usedrobot/demo-locker.git
cd demo-locker
cp .env.example .env    # optionally point at your own S3-compatible bucket
docker compose up
```

Three commands. See [docs/self-hosting.md](docs/self-hosting.md) for the full guide.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite |
| Backend | Hono |
| Database | SQLite — D1 hosted, embedded file self-host |
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
