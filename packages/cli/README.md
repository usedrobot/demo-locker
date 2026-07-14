# demo-locker

Setup wizard for [Demo Locker](https://github.com/usedrobot/demo-locker) —
self-hosted music streaming for demos and mixes your band can comment on,
with timestamps.

## Use

```bash
npx demo-locker
```

Answers a few questions (what do you need, where's it running, where do the
tracks live) and spins it up: Docker on the machine you're on (laptop, Pi,
VPS), Fly.io, or guided setup for Railway. Can also wire the embeddable
public player (`@demo-locker/player`) into an existing web project.

## Non-interactive (for scripts and agents)

Every question has a flag; `--yes` accepts defaults:

```bash
npx demo-locker --mode instance --target docker --storage local \
  --port 3001 --volume demolocker --email you@example.com --password ... --yes
```

`--dry-run` prints the deploy plan without running anything.

## Requirements

Node 20+, and Docker for the docker target (flyctl for fly).

Supported on macOS and Linux; Windows is untested (npm/docker spawning may
require a shell — use WSL).

s3 credentials are passed as container env vars; anyone with docker access to
the host can read them.
