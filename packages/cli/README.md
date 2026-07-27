# demo-locker

Setup wizard for [Demo Locker](https://github.com/usedrobot/demo-locker) —
self-hosted music streaming for demos and mixes your band can comment on,
with timestamps.

## Use

```bash
npx demo-locker
```

Answers a few questions (what do you need, where's it running, where do the
tracks live) and spins it up. Two ways to run it:

- **`cloudflare`** — a Worker plus a D1 database and an R2 bucket. Free tier,
  reachable from anywhere, nothing to maintain.
- **`docker`** — one container on the machine you're on (laptop, Pi, VPS).

Or point at an instance you already have with `existing`. Either way it can
also wire the embeddable public player (`@demo-locker/player`) into an
existing web project.

## Cloudflare

```bash
npx demo-locker --target cloudflare --domain demos.example.com
```

Provisions a Worker, a D1 database, and an R2 bucket, then deploys. Requires
`wrangler` to be installed and logged in — the wizard checks first and tells
you to run `wrangler login` if you aren't. R2 needs billing enabled on the
Cloudflare account (the free tier still applies, but a card must be on file).

The custom domain must be a zone on the same Cloudflare account; wrangler
provisions the DNS record and the certificate. Omit `--domain` and you get a
`workers.dev` URL instead — it's printed by the deploy step, since it isn't
knowable before then.

Resource names default to `demo-locker`, `demo-locker-db`, and
`demo-locker-demos`; override with `--worker-name`, `--d1-name`, and
`--r2-bucket`. There are no secrets on this path — D1 and R2 are bindings.

## Non-interactive (for scripts and agents)

Every question has a flag; `--yes` accepts defaults:

```bash
npx demo-locker --mode instance --target docker --storage local \
  --port 3001 --volume demolocker --email you@example.com --password ... --yes

npx demo-locker --mode instance --target cloudflare \
  --domain demos.example.com --email you@example.com --password ... --yes
```

`--email`/`--password` need a reachable URL, so on the cloudflare target they
require `--domain`. Without one, open the `workers.dev` URL afterwards and
sign up there — the first account in wins.

`--dry-run` prints the deploy plan without running anything.

## Requirements

Node 20+. Docker for the docker target; `wrangler` for the cloudflare target.

Supported on macOS and Linux; Windows is untested (npm/docker spawning may
require a shell — use WSL).

s3 credentials are passed as container env vars; anyone with docker access to
the host can read them.
