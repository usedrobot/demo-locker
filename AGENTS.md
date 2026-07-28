# AGENTS.md

Operator runbook for AI agents (or humans in a hurry) deploying Demo Locker
for someone. Every command below is copy-paste-runnable and every step
states its success signal. Read `/openapi.json` on a running instance for
the full API surface — this doc covers deployment and the minimum flow to
prove the instance works.

## What you're deploying

Demo Locker is one container: API + web UI + an embedded SQLite database,
all in a single process. Point it at `S3_ENDPOINT` and it uses real S3
storage instead of local disk — either way, database and audio files live
under one `/data` volume. Back up that volume and you've backed up the
whole instance, no separate database export needed.

## Scripted setup (preferred)

The wizard drives the whole deploy non-interactively:

```bash
npx demo-locker --mode instance --target docker --storage local --yes \
  --email USER_EMAIL --password USER_PASSWORD
```

The wizard's targets are `cloudflare`, `docker`, and `existing`. For no hardware
at all, deploy to Cloudflare instead — a Worker plus a D1 database and an R2
bucket, provisioned by the wizard:

```bash
npx demo-locker --mode instance --target cloudflare --yes \
  --domain DEMOS_EXAMPLE_COM --email USER_EMAIL --password USER_PASSWORD \
  --worker-name NAME --d1-name NAME-db --r2-bucket NAME-demos
```

**Name the resources.** The defaults are `demo-locker`, `demo-locker-db` and
`demo-locker-demos`. If the account already has a Demo Locker — or anything else
using those names — `wrangler d1 create` fails with "database already exists"
partway through, after the Worker name is taken but before anything is deployed.
Check first and pick distinct names:

```bash
npx wrangler d1 list
npx wrangler r2 bucket list
```

Never delete or rename an existing resource to free up a default name. Something
is probably using it.

Needs `wrangler` installed and logged in (`wrangler login`), R2 billing enabled
on the account (free tier still applies, but a card must be on file), and the
domain to be a zone on that same account. The wizard writes the custom domain
into the generated config and `wrangler deploy` provisions the DNS record and
certificate — there is no manual DNS step. The hostname must be genuinely free
first: if it already has a record (an old tunnel route, for instance), delete
that record before deploying or the deploy cannot claim it.

Drop `--domain` for a `workers.dev` URL — but then also drop
`--email`/`--password`, which the wizard rejects on that path: the URL isn't
known until the deploy prints it, so there's nothing to sign up against. Open it
afterwards and register; the first account in wins.

**A freshly deployed custom domain 500s for a few seconds** while the route and
certificate propagate. The wizard's health poll retries for 60s and absorbs it.
If you are checking by hand, retry for half a minute before concluding anything
is wrong.

Interview the human first: what hardware is on hand (old laptop / Pi / VPS /
nothing)? public listening or band-and-friends? Then map their answers onto the
flags above (`--target cloudflare` when there's no machine to run on;
`--storage s3 --s3-endpoint ...` on the docker target when they already have a
bucket). `--dry-run` prints the plan without touching anything.

## Path 1 (primary): standalone Docker

```bash
docker run -d -v demolocker:/data -p 3001:3001 ghcr.io/usedrobot/demo-locker:latest
```

expect: container starts and stays up (`docker ps` shows it running, not
restarting).

Boot log (`docker logs <container>`), in order:

```
db: sqlite (/data/db/demolocker.db)
storage: local disk (/data/audio) — set S3_ENDPOINT to use S3
⚠ zero-dependency mode: db is embedded (sqlite) and storage is local disk — all data lives under /data. If you expected S3, check your S3_ENDPOINT env var.
embed: serving ../player/dist/embed.js
openapi: serving ../../docs/openapi.json
web: serving ../web/dist
demo-locker api (self-hosted) running on :3001
```

If `DATA_DIR` (default `/data` in the image) isn't writable, boot fails
before any of these lines print — see Troubleshooting.

Verify:

```bash
curl -fsS http://localhost:3001/health
```

expect: `200` with `{"status":"ok","timestamp":"<ISO-8601 string>"}`.

## Path 2: Fly.io / Railway / Coolify

Platform-as-a-service, no server to manage. These are manual paths — the
wizard does not drive them; it deploys the same container to Cloudflare
instead (see "Scripted setup" above). The config templates still work if the
human already has an account on one of these. Full instructions in
[docs/deploy-templates.md](docs/deploy-templates.md). Fly.io in three
commands:

```bash
fly launch --copy-config --no-deploy
fly volumes create data --size 3
fly deploy
```

expect: `fly deploy` finishes with a deployed app URL; `curl
https://<app>.fly.dev/health` returns the same `{"status":"ok",...}` shape
as Path 1.

## Path 3: Build from Source (Docker Compose)

For production deployments where you want to build from source and use an
S3-compatible bucket instead of the zero-dependency image's local disk
storage. Full instructions in [docs/self-hosting.md](docs/self-hosting.md):

```bash
git clone https://github.com/usedrobot/demo-locker.git
cd demo-locker
cp .env.example .env
docker compose up
```

expect: frontend at `:5173`, API at `:3001`.

**Warning:** the web service's static build bakes `VITE_API_URL` in at
build time — it's a client bundle, not a runtime server. If you're serving
this to anything other than the machine running Docker, set `VITE_API_URL`
in `.env` to the API's reachable address *before* `docker compose build`,
or every API call from the built app will target `http://localhost:3001`
and only work from the host machine itself.

## API-only bootstrap runbook

Everything below assumes a running instance at `$BASE` (e.g.
`http://localhost:3001`). Requires `curl` and `jq`.

**Auth rules an agent must know:**
1. Authenticated API calls use `Authorization: Bearer <token>`.
2. Media elements (`<audio>`, `<img>`) can't send custom headers, so
   streaming/artwork routes also accept the same token via a `?token=`
   query param.
3. Gated endpoints return a non-enumerable `{"error":"not found"}` 404 for
   both "doesn't exist" and "exists but you can't see it." If you get a 404
   on something you expect to own, check your token before assuming the
   resource is missing.

### 1. Sign up

```bash
TOKEN=$(curl -fsS -X POST "$BASE/auth/signup" \
  -H 'Content-Type: application/json' \
  -d '{"email":"agent@example.com","password":"agentpass123"}' | jq -re .token)
```

expect: `201` with `{"user":{"id":"…","email":"…"},"token":"…"}`. `$TOKEN`
now holds the bearer token for every step below.

### 2. Create a playlist

```bash
PLAYLIST_ID=$(curl -fsS -X POST "$BASE/playlists" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"agent demo"}' | jq -re .playlist.id)
```

expect: `201` with `{"playlist":{"id":"…","name":"agent demo",...}}`.
`$PLAYLIST_ID` feeds the upload and publish steps.

### 3. Upload a track

Multipart form: `file` (required), `playlistId` (required), `title`
(optional — defaults to the filename minus extension).

If you are verifying an install rather than uploading someone's real music, make
a throwaway file rather than hunting for one — a two-second sine wave is enough
to exercise the whole path:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ac 2 -ar 44100 /tmp/dl-test.wav
```

(no ffmpeg? any small `.wav`, `.mp3` or `.flac` works — the server never
transcodes. The web app encodes a streaming rendition in the browser and posts
it as an extra `stream` part; a curl upload just omits it, and the original is
streamed directly.)

```bash
TRACK_ID=$(curl -fsS -X POST "$BASE/tracks/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/dl-test.wav;type=audio/wav" \
  -F "playlistId=$PLAYLIST_ID" \
  -F "title=Agent Demo Track" | jq -re .track.id)
```

expect: `201` with `{"track":{"id":"…","playlistId":"…","title":"…",...}}`.
`$TRACK_ID` feeds the public-metadata check below.

### 4. Make the playlist public

```bash
curl -fsS -X PATCH "$BASE/playlists/$PLAYLIST_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"isPublic":true}' | jq -re '.playlist.isPublic'
```

expect: `true`.

### 5. Fetch public metadata (no auth)

```bash
curl -fsS "$BASE/public/v1/playlists/$PLAYLIST_ID" | jq .
```

expect: `200` with
`{"playlist":{"id":"…","name":"…","artworkUrl":null|"…","tracks":[{"id":"…","title":"…","duration":…}]}}`.
This is the same route the embed player and any third-party integration
reads — no bearer token, works from any origin (CORS is wide open on
`/public/v1/*`).

### 6. Hand over the embed snippet

```bash
echo "<script src=\"$BASE/embed.js\"></script>"
echo "<demo-locker-player playlist=\"$PLAYLIST_ID\"></demo-locker-player>"
```

Drop those two lines into any page. See [docs/embed.md](docs/embed.md) for
theming, `::part()` hooks, and the full public API reference.

## Troubleshooting

- **Boot fails immediately, no log lines at all:** `DATA_DIR` (default
  `/data` in the image) isn't writable. Check the volume mount and its
  permissions.
- **`/embed.js` returns 404 (`player bundle not available on this
  deployment`):** the player bundle isn't in this build/deployment. On a
  self-hosted Node instance this means `PLAYER_DIST` doesn't point at a
  built `embed.js` — rebuild `packages/player` or check the boot log's
  `embed:` line.
- **`/openapi.json` returns 404:** same shape of problem — `OPENAPI_PATH`
  doesn't resolve to `docs/openapi.json` in this deployment. Check the
  boot log's `openapi:` line.
- **Port already in use:** something else on the host is bound to 3001.
  Either stop it or remap with `-p <other-port>:3001`.
- **Back up the data volume:**

```bash
docker run --rm -v demolocker:/data -v $(pwd):/backup alpine tar czf /backup/demolocker-backup.tar.gz /data
```

expect: `demolocker-backup.tar.gz` appears in the current directory. See
[docs/host-your-music.md](docs/host-your-music.md#backing-up) for the
restore command and off-machine backup advice.
