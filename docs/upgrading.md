# Upgrading Demo Locker

How to move a running locker to a newer version, for each way of running it.
Your tracks, playlists, comments and share links survive an upgrade on every
path here — but **back up first anyway**, see below.

New releases are announced on the [releases
page](https://github.com/usedrobot/demo-locker/releases). Check
[SECURITY.md](../SECURITY.md) for versions you should not be running.

## Back up first

Two minutes, and it makes every step below reversible.

- **Standalone image / Docker Compose:** back up the volume. Full commands in
  [self-hosting.md](self-hosting.md#backups) and
  [host-your-music.md](host-your-music.md#backing-up).
- **Cloudflare:** your data is in D1 and R2, neither of which an upgrade
  touches — a redeploy only replaces the Worker script and its static assets.
  `npx wrangler d1 export <db-name> --remote --output backup.sql` if you want
  a copy anyway.

## Which path are you on?

| How you installed | Go to |
|---|---|
| `npx demo-locker` with `--target cloudflare`, or the paste-into-your-agent prompt | [Cloudflare](#cloudflare) |
| `docker run ... ghcr.io/usedrobot/demo-locker` | [Standalone image](#standalone-docker-image) |
| `git clone` + `docker compose up` | [Build from source](#build-from-source) |
| Fly.io / Railway / Coolify | [PaaS](#flyio--railway--coolify) |

---

## Standalone Docker image

```bash
npx demo-locker@latest --upgrade
```

Recreates the container against the same volume, carrying over its port,
publish address (a `127.0.0.1`-only binding stays loopback-only) and
environment. The old container isn't deleted up front — it's renamed to
`<name>-preupgrade` and removed only once the new one answers `/health`. If
the new one never comes up, the CLI says so, leaves the old one in place, and
prints the command below — the failed new container is still running under the
original name and holding the port, so it has to be removed before the old one
can take its name back:

```bash
docker rm -f demolocker \
  && docker rename demolocker-preupgrade demolocker \
  && docker start demolocker
```

That `rm -f` is the *failed new* container. Never add `-v` to it — the volume
is what carries your music.

If your container is attached to a user-defined docker network, the CLI
refuses rather than recreating it on the default bridge, where anything that
reaches it by container name would lose it. Upgrade that one by hand with the
manual steps below, keeping your original `--network` (and any other flags
`docker inspect` shows).

The manual equivalent is below.

Pull the new image and recreate the container against the **same volume**:

```bash
docker pull ghcr.io/usedrobot/demo-locker:latest
docker stop demolocker && docker rm demolocker
docker run -d --name demolocker -v demolocker:/data -p 3001:3001 \
  ghcr.io/usedrobot/demo-locker:latest
```

The `-v demolocker:/data` is the part that matters — it's the same named
volume, so the SQLite database and your audio files carry over. **Never add
`-v` to the `docker rm`**, and never `docker volume rm`; that deletes
everything.

Migrations run automatically on API start. Confirm with `docker logs
demolocker` — you want the normal boot log ending in `demo-locker api
(self-hosted) running on :3001`, then:

```bash
curl -fsS http://localhost:3001/health
```

## Cloudflare

```bash
npx demo-locker@latest --upgrade --domain your.domain.com
```

`--domain` is required here: no read-only wrangler command can report a
Worker's custom domain, so discovery cannot learn it on its own — and
deploying without it would publish your locker at a second, public
`*.workers.dev` URL alongside your real one. Given the domain, the command
finds the instance, shows you what it found, and redeploys — applying any
pending D1 migrations first. Add `--dry-run` to see the plan without running
it, or `--target cloudflare` / `--worker-name <name>` if you run more than
one instance (discovery refuses to guess between them).

The version you get is the version of the CLI you run: `@latest` upgrades to
latest, `@0.2.9` downgrades to 0.2.9. That applies to the docker target too —
it pulls `ghcr.io/usedrobot/demo-locker:<cli version>`. If no image carries
that tag (a CLI-only patch release, say), it says so and uses `:latest`.

<details>
<summary>Doing it by hand</summary>

Upgrading is otherwise a manual redeploy against your existing Worker, D1
database and R2 bucket. Nothing is destroyed and no new resources are made.

You need the three resource names you installed with. If you don't remember
them, `npx wrangler d1 list` and `npx wrangler r2 bucket list` will show you.

**1. Get the new version's build artifacts:**

```bash
npm pack demo-locker@latest
tar xzf demo-locker-*.tgz
cd package/assets   # contains worker.js, public/, migrations/
```

**2. Write a `wrangler.jsonc` beside them** pointing at your existing
resources. Substitute your own names and your D1 database ID (from `wrangler
d1 list`):

```jsonc
{
  "name": "YOUR-WORKER-NAME",
  "main": "worker.js",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "YOUR-D1-NAME",
      "database_id": "YOUR-D1-ID",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [{ "binding": "DEMOS_BUCKET", "bucket_name": "YOUR-R2-BUCKET" }],
  "assets": {
    "directory": "public",
    "not_found_handling": "single-page-application",
    "run_worker_first": [
      "/health",
      "/auth", "/auth/*",
      "/playlists", "/playlists/*",
      "/comments", "/comments/*",
      "/shares", "/shares/*",
      "/collab", "/collab/*",
      "/tracks", "/tracks/*",
      "/public/v1", "/public/v1/*"
    ]
  },
  "routes": [{ "pattern": "your.domain.com", "custom_domain": true }]
}
```

> **Every API prefix must appear in both forms** — bare (`/playlists`) *and*
> wildcard (`/playlists/*`). Cloudflare serves static assets ahead of the
> Worker, so a prefix listed only as `/playlists/*` means `GET /playlists`
> falls through to the SPA and returns HTML instead of JSON. Sub-paths keep
> working, which makes it look healthy while every collection endpoint is
> broken. `/collab` is new on that list in 0.2.13 — an upgrade that keeps an
> older `run_worker_first` leaves the whole collaborators feature (invites,
> members, removal) answering with the SPA index. Drop the `routes` block
> entirely if you installed without a custom domain.

**3. Apply migrations BEFORE deploying:**

```bash
npx wrangler d1 migrations list YOUR-D1-NAME --remote --config wrangler.jsonc
npx wrangler d1 migrations apply YOUR-D1-NAME --remote --config wrangler.jsonc
```

**This order is not optional.** The ORM selects every column explicitly, so a
Worker deployed ahead of its migration breaks *all* reads of any table that
gained a column — not just the new feature. The `list` command is read-only
and tells you in one call whether there's anything to apply.

**4. Deploy:**

```bash
npx wrangler deploy
```

Secrets and bindings survive; they live in the Worker, not in this config
file. A correct run uploads only the changed assets.

**Two things that look like failures and aren't:**

- **A fresh deploy can return `error code: 1042` on random paths for ~30
  seconds**, then resolve itself. Wait a minute before diagnosing.
- **The first page load after an upgrade may still show the old app.** The
  service worker activates the new cache on the *next* navigation. Reload
  once more.

Verify:

```bash
curl -fsS https://your.domain.com/health
```

</details>

## Build from source

See [self-hosting.md § Updating](self-hosting.md#updating):

```bash
git pull
npm install
docker compose up --build
```

Migrations run automatically on API start. Don't add `-v` to any `docker
compose down` — that removes the `data` volume and your locker with it.

## Fly.io / Railway / Coolify

These run the same standalone image, so upgrading means redeploying it and
keeping the volume attached. Fly.io:

```bash
fly deploy
```

Railway and Coolify: trigger a redeploy from the dashboard, or push if you've
wired it to a repo. Confirm your volume is still mounted at `/data`
afterwards. See [deploy-templates.md](deploy-templates.md).

---

## Special case: `MAX_COLLABORATORS` set before 0.2.13

**Only affects you if you set `MAX_COLLABORATORS`.** It used to mean "share
links per playlist". As of 0.2.13 it means what its name says — how many
collaborators may share your library — and the per-playlist share-link ceiling
moved to a new `MAX_SHARE_LINKS`.

If you set it to limit share links, copy the value to `MAX_SHARE_LINKS` and
decide separately whether you want a collaborator cap. Leaving it as-is is not
dangerous — nothing breaks and nothing is exposed that was not before — but
your playlists become unlimited for share links, and the number you chose now
limits collaborators instead.

## Special case: databases from before the millisecond-timestamp change

If your locker predates that change, its timestamps are stored in seconds
while the schema now reads milliseconds, and every date in the app will
render somewhere around 1970. This one cannot be upgraded in place — the old
database has to go. Full detail in [self-hosting.md](self-hosting.md#quick-start-docker).

## If an upgrade goes wrong

- **Docker paths:** your volume is untouched by a bad image. Re-run the
  previous tag (`ghcr.io/usedrobot/demo-locker:<older>`) against the same
  volume.
- **Cloudflare:** `npx wrangler rollback` returns the Worker to its previous
  version. Note that a rollback does **not** undo an applied D1 migration, so
  if the new version added a column, roll the Worker back and leave the
  database as it is — the migrations here are additive and older code ignores
  columns it doesn't select.
- Either way, your audio and database are separate from the code being
  swapped. Losing them takes an explicit `docker volume rm`, a `down -v`, or
  deleting the D1/R2 resources by hand.
