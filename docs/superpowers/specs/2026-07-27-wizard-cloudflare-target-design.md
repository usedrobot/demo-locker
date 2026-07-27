# Wizard Cloudflare Target — Design

**Date:** 2026-07-27
**Package:** `packages/cli`
**Depends on:** `feat/sqlite-d1` merged to main

## Problem

The `npx demo-locker` wizard can stand up a Demo Locker via Docker, Fly, or Railway, or point at an
existing instance. It cannot deploy to Cloudflare — the platform the hosted instance already runs on
and the one with the best economics for an audio app (R2 has no egress fees).

DL's own instance at `demolocker.dlisok.com` is a Docker install on a VPS, exposed with a
`cloudflared` tunnel he wired by hand because the wizard's docker path ends at
`http://localhost:3001` and says nothing about reaching it from the internet. That instance is being
torn down and rebuilt through the wizard as the first real end-to-end test of this target.

## Scope

1. Add a `cloudflare` target that provisions Worker + D1 + R2 and deploys, optionally on a custom domain.
2. Drop the `fly` and `railway` targets.
3. Add an expose-to-the-internet step to the `docker` path.
4. Sweep `.env.example`, which still documents Postgres and `DATABASE_URL`.

Not in scope: the brochure page, the mobile ASCII sizing fix, the share icon, deleting the existing
`demolocker.dlisok.com` tunnel hostname (dashboard work), and any Vercel target.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Artifact delivery | Prebuilt, shipped inside the npm package | Direct analogue of the Docker image — the npm package *is* the artifact. No new release pipeline, no network fetch, no build on the user's machine. |
| Web hosting | Same Worker as the API, via the assets binding | `api.ts:1` already treats `VITE_API_URL=""` as same-origin. One deploy, one origin, no CORS, no build-time API URL, custom domain covers both. |
| Custom domain | Wizard writes a `custom_domain` route | Wrangler provisions DNS + cert when the zone is on the same account. One command instead of a dashboard trip. |
| Fly / Railway | Removed | Neither was ever exercised. Both ended in "read the output and figure it out." |
| Vercel | Not a target | Metered bandwidth on an audio-streaming workload, no D1 (would need a third DB adapter right after collapsing to one dialect), and function streaming limits. Vercel users are served by player mode. |
| Default target | `docker` stays the default | Needs no cloud account. Least surprising thing to land on by pressing enter. |

## Architecture

The wizard's existing shape is unchanged: `collectAnswers() → buildPlan() → Step[] → executePlan()`.
The Cloudflare target is a new `case` in `buildPlan` emitting `wrangler` steps, plus one new
capability in the `Runner` interface.

### Artifact layout

`packages/cli/assets/`, built at publish time by `publish-cli.yml` and included in the tarball:

```
assets/
  worker.js                 # pre-bundled Worker (wrangler deploy --dry-run --outdir)
  public/                   # web built with VITE_API_URL="", plus embed.js and openapi.json
  migrations/               # D1 SQL copied from packages/api/drizzle/
  wrangler.template.jsonc
```

Pre-bundling means the user's machine never runs `npm install` or a build. It also couples the CLI
version to the app version: shipping an app change means cutting a CLI release. Accepted.

### Deploy steps

Emitted in order by `buildPlan` for `target: "cloudflare"`:

1. `wrangler whoami` — if not authenticated, run `wrangler login` (interactive, opens a browser)
2. `wrangler d1 create <d1-name>` — **stdout captured** to read back `database_id`
3. `wrangler r2 bucket create <r2-bucket>`
4. Write `wrangler.jsonc` from the template: `DB` binding (with the captured id), `DEMOS_BUCKET`
   binding, assets directory, and a `custom_domain` route when a domain was given
5. `wrangler d1 migrations apply <d1-name> --remote`
6. `wrangler deploy`
7. Health poll, then first-account signup — existing `executePlan` code, unchanged

No secrets exist on this path. D1 and R2 are both bindings, so nothing sensitive is ever written to
disk, printed in the plan, or visible to `docker inspect`. This is the only target where that holds.

### Runner change

`Runner.exec` uses `stdio: "inherit"` and resolves to an exit code only, so step 2 cannot read the
`database_id` back. Add a sibling method:

```ts
execCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>
```

`Step` gains a `run-capture` kind carrying a parser, so `buildPlan` stays declarative and
`executePlan` stays the only place that touches the process.

### Assets-versus-Worker routing

**This is the one part that needs proving before the plan is written.**

Cloudflare serves static assets ahead of the Worker — `packages/api/src/index.ts:29` already documents
this for `/embed.js`. The React app needs SPA fallback so deep links resolve, but naive SPA fallback
returns `index.html` for *every* unmatched path, which means `/health`, `/auth/*`, `/tracks/*` and
the rest of the Hono routes never execute.

The intended fix is `assets.run_worker_first` scoped to the API path prefixes, with
`not_found_handling: "single-page-application"` for everything else. This must be verified on a
throwaway Worker before the implementation plan commits to it — the failure mode is a deploy that
looks successful and serves a completely broken app.

### Docker expose step

On a successful docker deploy, print three ways to reach the instance from outside the machine:
`cloudflared` tunnel (with the real commands), a Caddy reverse proxy, or LAN-only. Notes and commands
only — too many environments to automate reliably. This closes the gap DL hit building the original
`demolocker.dlisok.com`.

## Questions and flags

New question after target selection, cloudflare only:

> Custom domain? (blank for a workers.dev URL)

New flags, so agents can drive the target headlessly like every other question:
`--domain`, `--worker-name`, `--d1-name`, `--r2-bucket`.

Validation: `--domain` must be a bare hostname, not a URL. Passing `--domain`, `--worker-name`,
`--d1-name` or `--r2-bucket` with a non-cloudflare target is an error, matching the existing
`--url`/`--target` consistency rule.

## Testing

- `buildPlan` unit tests for the cloudflare case: step sequence, bindings, `database_id`
  substitution, domain present and absent.
- `collectAnswers` tests for the new question and flags, including the cross-target flag errors.
- Removal of the fly and railway plan tests.
- Assets-versus-Worker routing verified by hand on a throwaway Worker before implementation.
- CI cannot deploy to Cloudflare. **The live test is DL's `demolocker.dlisok.com` rebuild**, the same
  way real Docker was the live test for the docker target.

## Rollout

1. Merge `feat/sqlite-d1` (Task 6 — create the D1 database, wire the binding and the CI migration
   step — then whole-branch review, PR, and the Neon cutover with its 7-day rollback window).
2. Build this spec on a feature branch.
3. Cut a CLI release.
4. Delete the `demolocker.dlisok.com` public hostname from the `cowboy` tunnel in the Cloudflare
   dashboard, and decommission the VPS container.
5. Run `npx demo-locker@latest --target cloudflare --domain demolocker.dlisok.com` and record every
   place it is confusing or wrong.

## Risks

| Risk | Mitigation |
|---|---|
| SPA fallback swallows the API routes | Prove `run_worker_first` on a throwaway Worker before writing the plan |
| R2 requires billing enabled on the account | Detect and warn up front, before provisioning anything |
| `wrangler d1 create` output format changes | Parse defensively, fail with the raw output shown rather than a silent bad binding |
| CLI/app version coupling causes stale installs | Documented; revisit a GitHub release artifact if it becomes painful |
| Custom domain zone not on the user's account | Deploy fails with a clear message; the workers.dev URL still works |
