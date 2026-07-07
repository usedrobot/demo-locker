# npm Player Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing `<demo-locker-player>` web component as `@demo-locker/player` on npm (ESM + types), leaving the `/embed.js` script-tag path untouched.

**Architecture:** Packaging phase, not a feature phase. The single-file component in `packages/player/src/player.ts` gains a named class export and a tag-name type augmentation; the Vite lib build widens from IIFE-only to ES + IIFE; publishing happens via a tag-triggered GitHub Actions workflow using npm trusted publishing (OIDC, no token). Spec: `docs/superpowers/specs/2026-07-07-npm-player-package-design.md`.

**Tech Stack:** TypeScript, Vite lib mode, vitest + happy-dom, GitHub Actions, npm trusted publishing.

## Global Constraints

- Package name is exactly `@demo-locker/player`, version starts at `0.1.0`, license MIT.
- The component's runtime behavior must not change; `/embed.js` output keeps its filename, format (IIFE), and serving path on all three deploy targets.
- No npm token may be added to GitHub secrets — publish uses OIDC trusted publishing with `--provenance`.
- Publish workflow requires Node 24 (bundles npm ≥ 11.5, needed for OIDC); the existing CI jobs stay on Node 22.
- Repo CI convention is `npm install` (not `npm ci`) — follow it, with ONE deliberate exception: the publish workflow (Task 5) uses `npm ci` so the published build is byte-reproducible from the committed lockfile.
- Compatibility statement everywhere: "works with any Demo Locker instance serving `/public/v1`".
- npm consumers must set the `instance` attribute explicitly — every new doc surface states this (ESM has no `document.currentScript`, so the auto-detect silently falls back to the embedding page's own origin, which is wrong for third-party sites).
- No React/Vue wrappers, no API client, no changesets (spec's "Not doing" list).

---

### Task 1: Named export + tag-name types + first test suite

**Files:**
- Modify: `packages/player/src/player.ts:74` (class declaration) and `:243-245` (bottom of file)
- Create: `packages/player/src/player.test.ts`
- Create: `packages/player/vitest.config.ts`
- Modify: `packages/player/package.json` (add test script + devDeps)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: named export `DemoLockerPlayer` (class extending `HTMLElement`) from `packages/player/src/player.ts`; global `HTMLElementTagNameMap["demo-locker-player"]` typing. Tasks 2–3 build and package this module unchanged.

- [ ] **Step 1: Install test deps**

```bash
npm install -D vitest happy-dom -w packages/player
```

- [ ] **Step 2: Add test script and vitest config**

In `packages/player/package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

Create `packages/player/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
  },
});
```

- [ ] **Step 3: Write the failing tests**

Create `packages/player/src/player.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { DemoLockerPlayer } from "./player";

describe("@demo-locker/player module", () => {
  test("importing the module registers the custom element", () => {
    expect(customElements.get("demo-locker-player")).toBe(DemoLockerPlayer);
  });

  test("createElement produces an instance of the exported class", () => {
    const el = document.createElement("demo-locker-player");
    expect(el).toBeInstanceOf(DemoLockerPlayer);
    expect(el).toBeInstanceOf(HTMLElement);
  });

  test("re-importing the module does not throw (define guard)", async () => {
    await expect(import("./player")).resolves.toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -w packages/player`
Expected: FAIL — `player.ts` has no export, so `DemoLockerPlayer` is not exported (TS2459/undefined import).

- [ ] **Step 5: Add the export and type augmentation**

In `packages/player/src/player.ts`, change line 74:

```ts
export class DemoLockerPlayer extends HTMLElement {
```

And replace the bottom of the file (the existing define guard at lines 243–245) with:

```ts
declare global {
  interface HTMLElementTagNameMap {
    "demo-locker-player": DemoLockerPlayer;
  }
}

if (!customElements.get("demo-locker-player")) {
  customElements.define("demo-locker-player", DemoLockerPlayer);
}
```

No other line of the component changes.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w packages/player`
Expected: 3 passed.

- [ ] **Step 7: Verify typecheck, lint, and existing build still pass**

Run: `npm run typecheck -w packages/player && npm run build -w packages/player`
Expected: clean typecheck; `dist/embed.js` produced as before (export statements are legal in lib-mode entries; Vite strips them from the IIFE output — confirm `dist/embed.js` still ends by defining the element, not with a dangling `export`).

- [ ] **Step 8: Commit**

```bash
git add packages/player/src/player.ts packages/player/src/player.test.ts packages/player/vitest.config.ts packages/player/package.json package-lock.json
git commit -m "feat(player): export DemoLockerPlayer class, add tag-name types and first test suite"
```

---

### Task 2: Dual-format build + declaration emission

**Files:**
- Modify: `packages/player/vite.config.ts`
- Create: `packages/player/tsconfig.build.json`
- Modify: `packages/player/package.json` (build script)

**Interfaces:**
- Consumes: `packages/player/src/player.ts` from Task 1.
- Produces: `dist/player.js` (ESM), `dist/embed.js` (IIFE, unchanged role), `dist/player.d.ts`. Task 3's `exports` map and Task 5's artifact checks reference exactly these three paths.

- [ ] **Step 1: Widen the Vite lib build to two formats**

Replace `packages/player/vite.config.ts` with:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/player.ts",
      name: "DemoLockerPlayer",
      formats: ["es", "iife"],
      fileName: (format) => (format === "es" ? "player.js" : "embed.js"),
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: Emit declarations in the build script**

Create `packages/player/tsconfig.build.json` — a dedicated config so the test file's declarations never land in `dist/` (the base tsconfig includes all of `src`, and `files: ["dist"]` would ship a stray `player.test.d.ts`):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

In `packages/player/package.json`, change the build script (declaration emission runs after Vite because `emptyOutDir` wipes `dist/`):

```json
"build": "vite build && tsc -p tsconfig.build.json"
```

- [ ] **Step 3: Build and verify all three artifacts**

Run: `npm run build -w packages/player && ls -la packages/player/dist/`
Expected: exactly `player.js`, `embed.js`, `player.d.ts` — present, non-empty, and **no** `player.test.d.ts`. Check `player.d.ts` contains `export declare class DemoLockerPlayer` and the `HTMLElementTagNameMap` augmentation; check `player.js` contains `export` (ESM) and `embed.js` does not (IIFE).

- [ ] **Step 4: Verify the smoke test still passes with the widened build**

Run: `./scripts/smoke.sh`
Expected: PASS — the API still serves `dist/embed.js` at `/embed.js`.

- [ ] **Step 5: Commit**

```bash
git add packages/player/vite.config.ts packages/player/tsconfig.build.json packages/player/package.json
git commit -m "feat(player): dual-format build (ESM for npm + IIFE embed.js) with type declarations"
```

---

### Task 3: Publishable package.json + tarball verification

**Files:**
- Modify: `packages/player/package.json`

**Interfaces:**
- Consumes: `dist/player.js`, `dist/player.d.ts`, `dist/embed.js` from Task 2.
- Produces: the final publishable manifest. Task 5's version-match check reads `packages/player/package.json` `.version`.

- [ ] **Step 1: Write the full manifest**

Replace `packages/player/package.json` with (preserving the scripts/devDeps as they exist after Tasks 1–2):

```json
{
  "name": "@demo-locker/player",
  "version": "0.1.0",
  "description": "Embeddable music player web component for Demo Locker — self-hosted music streaming. Works with any instance serving /public/v1.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/player.js",
  "types": "./dist/player.d.ts",
  "exports": {
    ".": {
      "types": "./dist/player.d.ts",
      "import": "./dist/player.js"
    }
  },
  "files": ["dist"],
  "sideEffects": true,
  "repository": {
    "type": "git",
    "url": "git+https://github.com/usedrobot/demo-locker.git",
    "directory": "packages/player"
  },
  "homepage": "https://github.com/usedrobot/demo-locker/blob/main/docs/embed.md",
  "keywords": [
    "web-component",
    "music-player",
    "embeddable-music-player",
    "self-hosted",
    "audio",
    "playlist",
    "demo-locker"
  ],
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
  "scripts": {
    "build": "vite build && tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vite": "^8.0.1",
    "vitest": "<version installed in Task 1 — read it from the file before overwriting>",
    "happy-dom": "<version installed in Task 1 — read it from the file before overwriting>"
  }
}
```

Notes for the implementer: `"private": true` and `"version": "0.0.0"` are gone — that is the point of this task. Read the current file first and carry over the exact devDependency versions Task 1 installed; the two placeholders above are the only values you copy rather than type.

- [ ] **Step 2: Verify workspace still resolves and lockfile is stable**

Run: `npm install && git status --short`
Expected: `package-lock.json` updates for the rename (`@demo-locker/player` replaces the private name); no other changes.

- [ ] **Step 3: Verify the tarball contents**

Run: `npm pack --dry-run -w packages/player`
Expected output lists exactly: `dist/embed.js`, `dist/player.js`, `dist/player.d.ts`, `package.json`, and `README.md` if Task 6 ran first (task order here means no README yet — that's fine, npm warns but packs). No `src/`, no config files.

- [ ] **Step 4: Verify a consumer can resolve the entry**

Run:
```bash
node -e "const m = require('./packages/player/package.json'); const fs = require('fs'); ['main','types'].forEach(k => { if (!fs.existsSync(require('path').join('packages/player', m[k]))) { console.error('missing ' + k + ': ' + m[k]); process.exit(1); } }); console.log('entry points OK')"
```
Expected: `entry points OK` (run `npm run build -w packages/player` first if `dist/` is empty).

- [ ] **Step 5: Commit**

```bash
git add packages/player/package.json package-lock.json
git commit -m "feat(player): publishable manifest for @demo-locker/player 0.1.0"
```

---

### Task 4: CI runs the player tests

**Files:**
- Modify: `.github/workflows/ci.yml:23-32` (the `test` job)

**Interfaces:**
- Consumes: `npm test -w packages/player` from Task 1.
- Produces: CI coverage for the new suite on every push/PR.

- [ ] **Step 1: Add the player test run to the existing test job**

In `.github/workflows/ci.yml`, the `test` job currently ends with:

```yaml
      - run: npm test -w packages/api
```

Add directly below it (same indentation):

```yaml
      - run: npm test -w packages/player
```

- [ ] **Step 2: Verify locally that both commands pass from repo root**

Run: `npm test -w packages/api && npm test -w packages/player`
Expected: both suites PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run player package tests in the test job"
```

---

### Task 5: Tag-triggered publish workflow (trusted publishing)

**Files:**
- Create: `.github/workflows/publish-player.yml`

**Interfaces:**
- Consumes: build/test/typecheck scripts from Tasks 1–2; `.version` from Task 3.
- Produces: the release mechanism. The release procedure documented in Task 6's README references tag format `player-vX.Y.Z`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/publish-player.yml`:

```yaml
# Publishes @demo-locker/player to npm on tags matching player-v*.
#
# One-time setup (already done? verify on npmjs.com):
#   1. Create the npm org "demo-locker" (free, public packages).
#   2. On npmjs.com → package @demo-locker/player → Settings → Trusted publisher:
#      GitHub Actions, repository usedrobot/demo-locker, workflow publish-player.yml.
#      (For the FIRST publish, npm lets you configure the trusted publisher on the
#      org/package name before any version exists — do that, then push the tag.)
#   No npm token is stored anywhere; auth is OIDC (id-token: write) + provenance.
#
# Release procedure: bump "version" in packages/player/package.json, commit to main,
#   git tag player-vX.Y.Z && git push origin player-vX.Y.Z

name: Publish player

on:
  push:
    tags: ["player-v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      # npm ci (not npm install): the publish build must be byte-reproducible
      # from the committed lockfile — supply-chain hardening for the one job
      # that ships code to third parties. Other CI jobs keep npm install.
      - run: npm ci
      - run: npm run typecheck -w packages/player
      - run: npm run build -w packages/player
      - run: npm test -w packages/player
      - name: Verify tag matches package version
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#player-v}"
          PKG_VERSION="$(node -p "require('./packages/player/package.json').version")"
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "tag says $TAG_VERSION but package.json says $PKG_VERSION" >&2
            exit 1
          fi
      - name: Verify build artifacts
        run: |
          for f in player.js player.d.ts embed.js; do
            if [ ! -s "packages/player/dist/$f" ]; then
              echo "missing or empty dist/$f" >&2
              exit 1
            fi
          done
      - run: npm publish --provenance --access public -w packages/player
```

Do NOT attempt to `import()` the ESM build in bare Node anywhere in this workflow — the module touches `document` at top level by design; the vitest suite covers runtime behavior.

- [ ] **Step 2: Validate workflow syntax**

Run: `gh workflow list --repo usedrobot/demo-locker >/dev/null 2>&1; npx --yes action-validator .github/workflows/publish-player.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish-player.yml')); print('yaml OK')"`
Expected: `yaml OK` (or action-validator pass). The trigger can't be exercised until a tag is pushed — that's the manual release step at the end of this plan.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish-player.yml
git commit -m "ci: tag-triggered npm publish for @demo-locker/player via trusted publishing"
```

---

### Task 6: Documentation — npm README, embed.md, root README, llms.txt

**Files:**
- Create: `packages/player/README.md`
- Modify: `docs/embed.md` (new section after the opening script-tag example, i.e. after the "your-box … trust model" paragraph)
- Modify: `README.md:27` (feature bullet) 
- Modify: `llms.txt` (Docs list)

**Interfaces:**
- Consumes: package name/version from Task 3, release tag format from Task 5.
- Produces: all user-facing doc surfaces. Nothing downstream.

- [ ] **Step 1: Write the npm README**

Create `packages/player/README.md`:

````markdown
# @demo-locker/player

Embeddable music player for your own website — the `<demo-locker-player>` web component from [Demo Locker](https://github.com/usedrobot/demo-locker), the self-hosted music streaming and private demo sharing app. Zero dependencies, ~5 KB, themeable, framework-agnostic.

Works with any Demo Locker instance serving `/public/v1`.

## Install

```bash
npm install @demo-locker/player
```

```js
import "@demo-locker/player"; // registers <demo-locker-player>
```

```html
<demo-locker-player
  instance="https://your-box"
  playlist="PLAYLIST_ID"
></demo-locker-player>
```

**The `instance` attribute is required when installing from npm.** When the component is loaded as a script tag from a Demo Locker instance it auto-detects that origin; an npm-bundled module has no script origin, so you must point it at the box that hosts your playlist.

The `DemoLockerPlayer` class is a named export if you want manual registration or subclassing; `HTMLElementTagNameMap` is augmented, so `document.createElement("demo-locker-player")` is fully typed.

## No build step?

Load it straight off your instance instead — no npm needed:

```html
<script src="https://your-box/embed.js"></script>
<demo-locker-player playlist="PLAYLIST_ID"></demo-locker-player>
```

(Or from a CDN: `https://unpkg.com/@demo-locker/player/dist/embed.js` — then `instance` is required, same as npm.)

## Attributes

| Attribute | Required | Description |
|---|---|---|
| `playlist` | yes | ID of a playlist marked public on the instance. |
| `instance` | npm/CDN: yes · instance script tag: no | Origin to fetch metadata and audio from, e.g. `https://your-box`. |

Attributes are read once, when the element is connected — there are no `observedAttributes`. Set attributes before inserting the element; to switch playlists, remove and recreate it.

## Theming

Every visual value is a `--dl-*` custom property (`--dl-bg`, `--dl-fg`, `--dl-accent`, `--dl-muted`, `--dl-border`, `--dl-font`, `--dl-font-size`, `--dl-radius`, `--dl-padding`):

```css
demo-locker-player {
  --dl-accent: hotpink;
}
```

Structural nodes are exposed via `::part()` — `header`, `artwork`, `title`, `transport`, `button`, `seek`, `time`, `tracklist`, `track`, `status`, `footer`. Full theming docs: [docs/embed.md](https://github.com/usedrobot/demo-locker/blob/main/docs/embed.md).

## Versioning

Independent semver. The compatibility contract is the instance's `/public/v1` API; a hypothetical `/public/v2` target would be a major bump here.

## Releasing (maintainers)

Bump `version` in `packages/player/package.json`, commit to main, then:

```bash
git tag player-vX.Y.Z && git push origin player-vX.Y.Z
```

CI publishes with provenance via npm trusted publishing — no tokens.

## License

MIT
````

- [ ] **Step 2: Add the npm section to docs/embed.md**

In `docs/embed.md`, directly after the paragraph ending "…the only third party involved is the box you already run." insert:

```markdown
## Install from npm

Building the page with a bundler or framework (Vite, Next, Astro, …)? The same component ships as [`@demo-locker/player`](https://www.npmjs.com/package/@demo-locker/player):

```js
import "@demo-locker/player";
```

```html
<demo-locker-player instance="https://your-box" playlist="PLAYLIST_ID"></demo-locker-player>
```

One difference from the script tag: **`instance` is required**. A script tag loaded from your box auto-detects its origin; an npm-bundled module can't, so you point it at the instance explicitly. TypeScript types are included, and the `DemoLockerPlayer` class is a named export.
```

- [ ] **Step 3: Update the root README feature bullet**

In `README.md` line 27, change:

```markdown
- Public player — mark a playlist public, embed it on any site with two lines ([docs](docs/embed.md))
```

to:

```markdown
- Public player — mark a playlist public, embed it on any site with two lines, or `npm install @demo-locker/player` ([docs](docs/embed.md))
```

- [ ] **Step 4: Update llms.txt**

In `llms.txt`, change the docs/embed.md line:

```markdown
- [docs/embed.md](docs/embed.md): the embeddable player and the public read-only API (the SDK surface)
```

to:

```markdown
- [docs/embed.md](docs/embed.md): the embeddable player — script tag or `npm install @demo-locker/player` — and the public read-only API (the SDK surface)
```

- [ ] **Step 5: Verify the tarball now includes the README**

Run: `npm pack --dry-run -w packages/player`
Expected: file list now includes `README.md`.

- [ ] **Step 6: Commit**

```bash
git add packages/player/README.md docs/embed.md README.md llms.txt
git commit -m "docs(player): npm install surface across README, embed.md, llms.txt"
```

---

### Task 7: Release 0.1.0 (manual gate — requires DL)

**Files:** none (npmjs.com configuration + git tag)

**Interfaces:**
- Consumes: everything above, merged to main.
- Produces: `@demo-locker/player@0.1.0` live on npm with a provenance badge.

This task cannot be fully automated — org creation and trusted-publisher configuration happen on npmjs.com under DL's account. Steps:

- [ ] **Step 1 (DL):** Create the npm org `demo-locker` at npmjs.com (free tier, public packages).
- [ ] **Step 2 (DL):** Configure the trusted publisher for `@demo-locker/player`: GitHub Actions / repository `usedrobot/demo-locker` / workflow `publish-player.yml`. npm supports configuring this before the first publish.
- [ ] **Step 3:** Merge the feature branch to main (normal PR + review flow). No migrations → no prod-Neon step.
- [ ] **Step 4:** Tag and push:

```bash
git checkout main && git pull
git tag player-v0.1.0 && git push origin player-v0.1.0
```

- [ ] **Step 5:** Watch the workflow: `gh run watch --repo usedrobot/demo-locker` — expect the publish job green.
- [ ] **Step 6: Verify success criteria** (from the spec):

```bash
npm view @demo-locker/player version dist.tarball   # → 0.1.0
```

Then in a scratch dir:

```bash
npm create vite@latest dl-player-check -- --template vanilla-ts
cd dl-player-check && npm install && npm install @demo-locker/player
```

Add to `src/main.ts`: `import "@demo-locker/player";` and drop `<demo-locker-player instance="https://demo-locker-api.fldl.workers.dev" playlist="<a-public-playlist-id>"></demo-locker-player>` into `index.html`, `npm run dev`, confirm the player renders and plays. Confirm the npmjs.com page shows the provenance badge. Confirm `https://demo-locker-api.fldl.workers.dev/embed.js` still serves the IIFE (smoke criterion #3).
