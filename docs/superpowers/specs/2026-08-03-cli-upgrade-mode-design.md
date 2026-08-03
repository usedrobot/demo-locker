# Demo Locker — CLI upgrade mode

**Date:** 2026-08-03
**Scope:** Add `--upgrade` to `packages/cli`, so an existing instance can be moved to a new version in place. Covers the `cloudflare` and `docker` targets. No changes to the app, the API, or the install path.

## Problem

`npx demo-locker` only ever **creates**. There is no way to update an instance it made.

Upgrading one today means, by hand: `npm pack demo-locker@X`, untar it, write a `wrangler.jsonc` that points at the instance's existing Worker, D1 database id, R2 bucket and custom domain, run `d1 migrations apply --remote`, then `wrangler deploy`. DL's instance has been through this five times. The procedure lives in `docs/upgrading.md` and in a scratch directory on one machine.

Two consequences:

1. **Every release stops at the person who cut it.** Anyone who installed from the brochure prompt has no supported way to take a fix. That mattered concretely on 2026-08-03: `0.2.9` and earlier shipped an `[x]` control that permanently deleted a track's master while every label on it said "remove". The fix reached DL's locker the same day and everyone else only when they happened to reinstall.
2. **The manual path is where the sharp edges are.** Migrations must be applied *before* deploy, because the ORM selects every column explicitly and a Worker running ahead of its migration breaks every read of any table that gained a column. On the Docker path, a stray `-v` on `docker rm` deletes the volume holding the user's audio. Both are currently guarded by nothing but a human reading a runbook.

## Shape

A `--upgrade` flag, not a subcommand. `cli.ts` and `main.ts` parse flags today; introducing a verb layer for a single verb costs more than it returns.

```
npx demo-locker@latest --upgrade
npx demo-locker@latest --upgrade --target cloudflare --yes
npx demo-locker@latest --upgrade --dry-run
```

**The version you upgrade to is the CLI version you run.** Built assets ship inside the npm tarball — the package *is* the artifact — so `@latest` means "upgrade to latest" and `@0.2.9` means "downgrade to 0.2.9". There is no `--version` flag, and adding one would introduce a second source of truth for what gets deployed.

Following the existing convention that every prompt has a non-interactive flag so agents can drive the tool, `--upgrade` adds `--yes` (skip the confirmation) and `--dry-run` (render the resolved plan and exit without executing).

`--upgrade` is mutually exclusive with the install-only flags (`--mode`, `--storage`, `--port`, `--volume`). Passing them together is an error, not a silent ignore — the wizard already hard-errors on incompatible flag combinations and this follows that.

The naming flags are **not** excluded. `--worker-name`, `--d1-name`, `--r2-bucket` and `--domain` act as explicit overrides on upgrade: any name supplied is taken as given and not discovered. This is the escape hatch for an instance whose names do not follow the convention, and the only way to drive an upgrade non-interactively when more than one instance exists on the account. Supplying a subset is allowed — the rest are discovered.

## Discovery

Probe both targets, ask only when the answer is ambiguous. `--target` short-circuits detection entirely.

### Docker

```
docker ps -a --filter ancestor=ghcr.io/usedrobot/demo-locker --format {{.ID}}
docker inspect <id>
```

`docker inspect` yields everything needed to recreate the container faithfully: the mounted volume name, the published port, and the environment. These are read back and reused verbatim rather than reconstructed from defaults — an instance running on a non-default port, or with `ALLOW_SIGNUP` or S3 credentials set, must come back up with exactly those.

### Cloudflare

```
wrangler d1 list --json
wrangler r2 bucket list
wrangler deployments list --name <candidate>
```

`d1 list --json` returns `{uuid, name}` per database. Candidate Worker names are derived by stripping a trailing `-db` from the database name (`demo-locker-dlisok-db` → `demo-locker-dlisok`), then **verified** with `deployments list --name`; a candidate that does not resolve is dropped. The R2 bucket is matched the same way (`-demos` suffix) and likewise confirmed present in `r2 bucket list`.

**Do not use `num_tables` to identify a Demo Locker database.** Verified 2026-08-03: `wrangler d1 list --json` reports `num_tables: 0` for `demo-locker-dlisok-db`, which is live and serving. The field cannot be trusted as a schema signal.

There is deliberately no schema sniffing at all. Identification is by naming convention, and the user confirms before anything is written. A heuristic that guesses right silently is worse here than one that shows its work.

### Resolution

| Docker hit | Cloudflare hit | Behaviour |
|---|---|---|
| one | none | Show it, confirm, upgrade |
| none | one | Show it, confirm, upgrade |
| one | one | Ask which |
| many | — | Ask which |
| none | none | Explain what was probed and exit non-zero |

The zero-hit message names both probes and what would have matched, so someone whose instance is on Fly or a bare VPS learns why it was not found instead of concluding the tool is broken.

**Ambiguity is never resolved silently.** Any row above that says "Ask which" is a hard error under `--yes` or `--dry-run` with no TTY, listing the candidates and telling the caller to disambiguate with `--target` or the naming flags. An unattended run must never pick an instance on the user's behalf — the whole point of upgrade is that it writes to something that already exists and holds data.

## Execution

`buildUpgradePlan(discovered)` returns the same `Step[]` union that `buildPlan` already produces (`run` / `run-capture` / `write` / `copy` / `note`), so `executePlan` runs it unchanged. No new machinery in `execute.ts`.

### Cloudflare plan

1. `copy` packaged assets (`worker.js`, `public/`, `migrations/`) into a fresh temporary directory, removed on exit. The install path writes into a `demo-locker/` directory in the cwd because that directory is the user's new instance and they keep it; an upgrade produces nothing worth keeping, and writing into the cwd would collide with an existing install directory or litter whatever folder the command was run from.
2. `write` `wrangler.jsonc` from the **discovered** names, using the existing `wranglerConfig()` so the `run_worker_first` list stays generated rather than hand-copied
3. `run` `wrangler d1 migrations list --remote` — read-only, reported to the user
4. `run` `wrangler d1 migrations apply --remote`
5. `run` `wrangler deploy`
6. health poll

Steps 4 and 5 are ordered and that order is load-bearing. It is asserted by a test, not left to the sequence happening to be written correctly.

### Docker plan

1. `run` `docker pull ghcr.io/usedrobot/demo-locker:latest`
2. `run` `docker stop <container>`
3. `run` `docker rm <container>` — **never `-v`**
4. `run` `docker run` with the volume, port and env read back from `docker inspect`
5. health poll

No migration step: the standalone image runs migrations on API start.

### `existing` target

`--target existing` is player-only mode pointing at an instance someone else runs. There is nothing to upgrade. It prints that and exits 0 — a clean no-op, not an error and not a pretend success.

## Safety

Preflight, then one confirmation, then execute:

- Print what was discovered (target, resource names) and the exact plan, plus the version being installed — which is the running CLI's own version.

  The instance's *current* version is deliberately not reported. Nothing on either target records it: the Cloudflare path stores no version marker, and the Docker path can only show an image digest, which is not a version a user recognises. Printing "unknown → 0.2.11" is honest; printing a guess is not. Recording a version marker at deploy time would make this answerable, but it is a change to the deploy path and belongs in its own piece of work.
- Confirm once, unless `--yes`.
- `--dry-run` renders the plan via the existing `renderPlan()` and exits before any step runs.

**No backups.** Neither path deletes data: a Worker redeploy replaces the script and assets and never touches D1 or R2, and the Docker path reuses the existing volume. A backup step would be slow for a large locker, need somewhere to put the output, and protect against a risk the design does not create. Backup guidance stays in `docs/upgrading.md` where it belongs.

**Post-deploy verification is deferred, deliberately.** A fresh Cloudflare deploy returns `error code: 1042` on random paths for roughly 30 seconds, and requesting an asset before it propagates makes Cloudflare cache the SPA-fallback 404 for that URL — so an eager check does not merely mislead, it briefly makes things worse. The existing 60s health poll already absorbs this window; nothing shorter is added.

## Testing

`packages/cli` has 88 tests and injects its runner, so all of this is testable without touching a real instance.

- **Discovery parsing** — a `d1 list --json` fixture, a `docker inspect` fixture, and the ambiguous, multiple and zero-hit resolutions.
- **Plan shape per target** — cloudflare vs docker vs existing.
- **Two tests that exist because the failure costs someone their masters:**
  - no step in any docker plan contains `-v` in its args
  - `d1 migrations apply` always precedes `wrangler deploy` in the cloudflare plan
- **Flag conflicts** — `--upgrade` with install-only flags errors.

Both data-loss tests are mutation-checked: revert the guard, confirm the test fails. A test that still passes with the fix removed is not a test.

## Out of scope

- Rollback. `wrangler rollback` exists for the Worker, and the Docker path rolls back by running an older tag. Neither needs wrapping yet.
- Fly/Railway/Coolify. They run the same standalone image but the wizard does not deploy them, and inventing discovery for platforms it cannot install to is speculative.
- Backups (above).
- A state file written at install time. It would only ever help instances created *after* it ships — every locker that exists today, including DL's, would still need discovery. Discovery subsumes it.
