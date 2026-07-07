# Demo Locker — Agent-Readiness Design

**Date:** 2026-07-07
**Status:** Approved by DL (direction + design confirmed in session; spec written for fresh-context execution)
**Builds on:** Phase A (zero-dep self-hosting, PR #1) and Phase B (public player, PR #2), both merged.

## Why

The discovery funnel for Demo Locker is AI agents. Users ask Claude/ChatGPT/OpenClaw/Hermes "how do I self-host my music," "how do I put a music player on my own site," "how do I share private mixes without SoundCloud" — and the agent both *answers* and increasingly *executes*. Two consequences:

1. Demo Locker must be **legible to agents** — the exact phrases users ask must appear in our docs, and a machine-readable map must exist.
2. Setup must be **executable by agents** — every step of zero-to-streaming must work as deterministic commands with verifiable outputs, no browser required. (The API already supports this end-to-end; `scripts/smoke.sh` proves it. This phase packages that knowledge.)

Out of scope now, parked deliberately: directory submissions and launch posts (until DL says go-public); the Demo Locker MCP server (own brainstorm); the npm player package (next phase).

## Deliverables

### 1. `AGENTS.md` (repo root)

The operator-agent runbook. Audience: an AI agent (or human in a hurry) deploying Demo Locker for someone. Structure:

- **What you're deploying** — 3 sentences, the one-container architecture, where data lives.
- **Path 1 (primary): standalone Docker** — exact `docker run`, expected boot log lines (`db: pglite (...)`, `storage: local disk (...)`, `web: serving ...`, `embed: serving ...`), verification (`curl /health` → exact JSON shape).
- **Path 2: Fly/Railway/Coolify** — pointer to `docs/deploy-templates.md` with the two or three commands inline for Fly.
- **Path 3: Postgres + S3 (compose)** — pointer to `docs/self-hosting.md`, including the `VITE_API_URL` build-arg requirement for non-localhost use.
- **API-only bootstrap runbook** — the full flow as curl, each step with the expected response shape and the jq path to extract what the next step needs: signup (`POST /auth/signup` → token), create playlist (`POST /playlists` → id), upload track (`POST /tracks/upload` multipart → track id), make public (`PATCH /playlists/:id` with `{"isPublic": true}`), fetch public metadata (`GET /public/v1/playlists/:id`), the embed snippet to hand the user. State the auth rules an agent must know: `Authorization: Bearer <token>` for API calls; `?token=` for media URLs; share links via `POST /playlists/:id/shares`-family endpoints (document the actual routes as implemented).
- **Troubleshooting** — keyed on real symptoms: boot fails fast on unwritable `DATA_DIR`; `/embed.js` 404 means the player bundle isn't in the deployment; port conflicts; where the data volume lives and how to back it up (one tar command).

Every command block must be copy-paste-runnable and every step must name its success signal. No prose steps without a verification.

### 2. README reframing

Keep the TUI voice and structure. Change the aim: the title block and "Why" section lead with all three funnel identities, using verbatim the phrases users ask agents:

- **self-hosted music streaming** / host your own music (streaming-platform alternative)
- **embeddable music player for your own website** (two-line embed)
- **private demo sharing** with timestamped comments (the original identity)

The "Why" section's platform comparisons stay (Dropbox/SoundCloud) and gain the "streaming platforms own your distribution" line from the umbrella spec. Feature list gains nothing new — reorder so public player + embed sit near the top. Add a short "For AI agents" line near the install section pointing at `AGENTS.md` and `/llms.txt`.

### 3. `llms.txt` (repo root)

The emerging convention: a compact plain-text/markdown map for agents. Contents: one-paragraph description (hitting the three identities), the one-line install, and a linked index — `AGENTS.md` (setup runbook), `docs/embed.md` (player + public API/SDK), `docs/host-your-music.md` (beginner guide), `docs/self-hosting.md` (Postgres+S3), `docs/openapi.json` (API description), license, repo URL.

### 4. OpenAPI description, served by every instance

- Hand-written **`docs/openapi.json`** (OpenAPI 3.1, JSON not YAML — agents consume it directly and it can be served verbatim). Covers: `/health`, auth (signup/login/logout/me), playlists CRUD + artwork + reorder, tracks upload/stream/delete, comments (create/read/resolve/delete), shares (create/list/revoke/invite-resolution), and the full `/public/v1` surface. Response shapes matched to the actual code (the routes are the source of truth — read them while writing). Auth documented as: bearer token; `?token=` query alternative on stream/artwork; non-enumerable 404 semantics stated in the description of gated endpoints.
- **Served at `GET /openapi.json`** from every instance, same architecture as `/embed.js`: shared route reading an `OPENAPI_JSON` binding; Node fills it by reading the file from disk (`OPENAPI_PATH` env, default resolves to the repo/image copy); standalone image COPYs the file; the Worker gets it via the deploy script copying `docs/openapi.json` into the assets directory (assets-first serving, same documented divergence as `/embed.js`). Content-Type `application/json`, `Cache-Control: public, max-age=3600`.
- `scripts/smoke.sh` gains one assertion: `GET /openapi.json` → 200 + `application/json`.

## Acceptance

- An agent given only the repo URL (or a running instance URL) can: discover what Demo Locker is, deploy it, create an account, upload a track, publish it, and produce the embed snippet — entirely from `AGENTS.md`/`llms.txt`/`/openapi.json`, no UI, no guessing.
- The AGENTS.md runbook is verified by execution: every command run against a fresh zero-dep boot during implementation, outputs captured.
- `docs/openapi.json` passes an OpenAPI validator, and its documented shapes match the live API (spot-checked against real curl output for at least: signup, playlist create, upload, public metadata).

## Non-goals

Directory/list submissions; launch posts; MCP server; npm package; any API behavior changes (this phase is documentation + one static-serving route; if a doc-vs-code mismatch is found, the doc matches the code and the mismatch is reported, not fixed here).
