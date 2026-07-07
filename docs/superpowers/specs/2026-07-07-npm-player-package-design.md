# Demo Locker — npm Player Package Design

**Date:** 2026-07-07
**Status:** Approved by DL (scope, name, pipeline, and versioning confirmed in session; spec written for fresh-context execution)
**Builds on:** Phase B public player (`packages/player`, PR #2) and Agent-Readiness (PR #3), both merged. This is the "npm player package" phase parked in the agent-readiness spec.

## Why

The `<demo-locker-player>` web component currently has one distribution channel: an IIFE served at `/embed.js` on every Demo Locker instance. That's perfect for plain-HTML embedders, but framework users (Next/Astro/Vite apps — and the AI site-builders that scaffold them) expect `npm install`. Publishing the existing component to npm gives them a typed, importable, versioned artifact without touching the script-tag path.

This is a **packaging phase, not a feature phase**. The component itself does not change behavior. The npm surface is deliberately minimal: the web component as ESM plus types. No React/Vue wrappers, no typed API client, no JSX augmentations, no changesets — all revisit-on-demand.

## Decisions (made in session, do not relitigate)

| Question | Decision |
|---|---|
| Package scope | Web component as ESM + types only. Packaging, not new code. |
| Name | `@demo-locker/player` — new npm org `demo-locker` (name verified free 2026-07-07, as were `demo-locker`, `demo-locker-player`, `@demolocker/player`). Matches the existing workspace name, zero rename churn, leaves room for `@demo-locker/client` / `/cli` later. |
| Publish flow | CI on git tag `player-v*` with npm **trusted publishing** (OIDC) + `--provenance`. No npm token stored in GitHub secrets. |
| Versioning | Independent semver starting **0.1.0**. The `/public/v1` URL path is the compatibility contract; targeting a hypothetical `/public/v2` would be a player major bump. 1.0.0 when the npm surface settles. |

## Deliverables

### 1. Package surface (`packages/player`)

- Drop `"private": true`; set `"name": "@demo-locker/player"`, `"version": "0.1.0"`, plus the standard OSS metadata npm displays: `description`, `license: "MIT"`, `repository` (with `directory: "packages/player"`), `homepage`, `keywords` (include the funnel phrases: embeddable music player, web component, self-hosted music).
- **Module behavior:** importing the package registers `<demo-locker-player>` as a side effect (the `customElements.get()` double-define guard already exists at the bottom of `player.ts`); the `DemoLockerPlayer` class becomes a **named export** for manual registration or subclassing. Add an `HTMLElementTagNameMap` augmentation so `document.createElement("demo-locker-player")` and `querySelector` are typed.
- `package.json` packaging fields: `exports` map (`"."` → `import: dist/player.js`, `types: dist/player.d.ts`), `files: ["dist"]`, `sideEffects: true` (element registration must survive tree-shaking), `publishConfig: { "access": "public", "provenance": true }`.
- Types via `tsc --emitDeclarationOnly` into `dist/` (single source file; no dts plugin needed). Wire into the build script.

### 2. Build — one Vite config, two formats

Extend the existing lib-mode config from `formats: ["iife"]` to `["es", "iife"]` with a per-format `fileName`: ES → `dist/player.js` (npm entry), IIFE → `dist/embed.js` (byte-for-byte the same role as today). **Nothing about `/embed.js` serving changes** — the API's asset-binding pattern on all three deploy targets keeps consuming `dist/embed.js`. Verify the existing CI `check`/`smoke` jobs still pass with the widened build.

Bonus, free: `dist/embed.js` ships in the npm tarball, so unpkg/jsdelivr become CDNs for script-tag users who'd rather not load off an instance (`https://unpkg.com/@demo-locker/player/dist/embed.js` — those users must set `instance` explicitly).

### 3. The `instance` attribute story (docs, not code)

`player.ts` derives its default instance origin from `document.currentScript.src`, which is always `null` in ESM. No code change — but every doc surface must state it plainly:

- **Script tag from an instance:** `instance` optional (auto-detected from script origin) — unchanged.
- **npm import (or CDN-loaded ESM):** `instance="https://your-box"` is **required**. Silently falling back to the embedding app's own origin would be a confusing default for third-party sites, so we document rather than guess.

### 4. Publish pipeline

- **One-time manual setup (DL, outside CI):** create the `demo-locker` npm org; on npmjs.com configure the package's trusted publisher = `usedrobot/demo-locker` + the exact workflow filename below. Document these steps in the workflow file's header comment so the setup is reconstructible.
- **New workflow `.github/workflows/publish-player.yml`**, triggered by tag push matching `player-v*`:
  1. checkout, setup Node ≥ 24 with npm ≥ 11.5 (OIDC-capable), `npm ci`
  2. typecheck + lint + build + test for `packages/player`
  3. assert the tag version equals `packages/player/package.json` version — fail loudly on mismatch
  4. `npm publish --provenance --access public -w packages/player` (needs `permissions: id-token: write`)
- **Release procedure** (goes in the player README's contributing/release section): bump `version` in `packages/player/package.json`, commit to main, `git tag player-vX.Y.Z`, push the tag. That's the whole release.

### 5. Docs

- **New `packages/player/README.md`** — the npm landing page. Structure: what it is (one paragraph, funnel phrasing); install + framework usage example (import → element in JSX/HTML with `instance` + `playlist`); the plain-script-tag alternative for completeness; attribute table (`playlist` required, `instance` required-for-npm — including the read-once/no-`observedAttributes` caveat from docs/embed.md); condensed theming section (the `--dl-*` variable list) linking to `docs/embed.md` for `::part()` and full detail; compatibility statement ("works with any Demo Locker instance serving `/public/v1`"); release procedure.
- **`docs/embed.md`** gains an "Install from npm" section near the top showing the import path as an alternative to the script tag, with the `instance` requirement called out.
- **Root `README.md` and `llms.txt`** get one-line mentions of the package — npm is how AI site-builders will install this, continuing the agent-readiness funnel work.

### 6. Testing

First test suite in `packages/player` (vitest with the `happy-dom` environment; the repo already uses vitest in `packages/api`):

- importing the module registers `demo-locker-player` in the custom element registry
- the `DemoLockerPlayer` named export is a constructable custom element class
- double-import doesn't throw (define guard)

Separately, the publish workflow gets a build-artifact sanity step after `npm run build`: assert `dist/player.js`, `dist/player.d.ts`, and `dist/embed.js` all exist and are non-empty. (Don't try to `import()` the ESM build in bare Node — the module touches `document` at top level by design; the vitest suite covers runtime behavior in a DOM environment.)

The publish workflow reruns all checks before publishing; the existing CI `check` job picks up the new tests via the workspace test run (verify wiring).

## Not doing (parked deliberately)

- React/Vue wrapper components — web components work fine in modern React; wrappers only if someone asks.
- Typed `/public/v1` API client (`@demo-locker/client`) — the org scoping leaves room; separate brainstorm if wanted.
- JSX/framework type augmentations beyond `HTMLElementTagNameMap`.
- Changesets or any release automation beyond tag-triggered publish.
- Any behavior change to the player component itself.

## Success criteria

1. `npm install @demo-locker/player` + `import "@demo-locker/player"` in a fresh Vite app renders a working player against the hosted instance (with `instance` set).
2. TypeScript consumers get types for the element and the class with no config.
3. `/embed.js` on all three deploy targets is byte-identical in role and behavior to before this phase (smoke test still green).
4. Publishing 0.1.0 happens entirely via tag push, shows the provenance badge on npmjs.com, and no npm token exists in GitHub secrets.
5. The npm README makes the `instance` requirement impossible to miss.
