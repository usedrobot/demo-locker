# Agent-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demo Locker becomes legible to and executable by AI agents: `AGENTS.md` runbook, README reframed around the three funnel phrases, `llms.txt`, and an OpenAPI description served at `/openapi.json` by every instance.

**Architecture:** Documentation-first phase. One code change: `/openapi.json` served via the same binding pattern as `/embed.js` (shared Hono route + `OPENAPI_JSON` binding on Node/standalone; deploy-script copy into the Worker assets dir). No API behavior changes — if docs and code disagree, docs match the code and the mismatch is reported.

**Tech Stack:** Markdown, OpenAPI 3.1 (JSON), Hono route + binding, Dockerfile COPY, one smoke assertion.

**Spec:** `docs/superpowers/specs/2026-07-07-agent-readiness-design.md`

## Global Constraints

- Branch: `feat/agent-readiness` from up-to-date `main` (Task 1 Step 1). Never commit to main.
- **No API behavior changes** beyond adding the `/openapi.json` route. Docs describe the code as it IS.
- **Schema-parity rule (vault, after the PR #2 incident): this phase adds NO migrations — keep it that way.**
- Repo voice: plain, direct, a little dry (match README's "Why"). No marketing fluff.
- TypeScript ESM `.js` suffixes; `npm run typecheck` + `npm test -w packages/api` + `./scripts/smoke.sh` green before the final commit of any code-touching task.
- Conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Reference facts (verified in the prior session — trust these, spot-check cheaply)

- `/embed.js` pattern to mirror: `EMBED_JS?: string` in `packages/api/src/types.ts` Bindings; route in `packages/api/src/index.ts`; Node fills it in `packages/api/src/server.ts` via `existsSync`/`readFileSync` with an env override; standalone Dockerfile stage COPYs the artifact; Worker gets the file assets-first from `../player/dist` (wrangler.jsonc `assets.directory`), making the Hono route dead code on that target (documented divergence).
- `packages/api/package.json` deploy script is currently `npm --prefix ../player run build && wrangler deploy` — Worker asset additions go through here.
- The no-store middleware in `index.ts` is a set-if-absent backstop — a route that sets its own `Cache-Control` wins.
- The API-only flow (signup → playlist → upload → publish → public fetch) is exactly what `scripts/smoke.sh` runs — it is the authoritative source for request/response shapes when writing AGENTS.md and the OpenAPI file, alongside the route sources.
- Auth: `Authorization: Bearer <token>`; media elements use `?token=`; gated endpoints return non-enumerable `{"error":"not found"}` 404s.

---

### Task 1: README reframing + llms.txt

**Files:**
- Modify: `README.md`
- Create: `llms.txt`

**Interfaces:**
- Produces: the three funnel phrases in README headings; `llms.txt` linking `AGENTS.md` (created in Task 3 — link it anyway, same branch).

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull && git checkout -b feat/agent-readiness
```

- [ ] **Step 2: Reframe README**

Read the current `README.md` in full first. Requirements:
- The box-art tagline and opening paragraph widen from demos-only to the three identities, keeping the TUI voice. The following phrases must appear verbatim somewhere in the title block, Why, or Features headings: **"self-hosted music streaming"**, **"embeddable music player for your own website"** (or "for your band's website"), **"private demo sharing"**.
- "Why" keeps Dropbox/SoundCloud comparisons, adds one line to the effect of: streaming platforms own your distribution; Demo Locker means your music streams from a box you control.
- Reorder Features so the public player/embed items sit directly after the upload/playlist basics.
- Near Quick Start add: `**Setting this up with an AI agent?** Point it at [AGENTS.md](AGENTS.md) — a step-by-step runbook with verification for every step. Machine-readable map: [llms.txt](llms.txt). Running instances self-describe at /openapi.json.`
- Do not remove existing sections (Quick Start, Self-Host, Stack, docs links).

- [ ] **Step 3: Write llms.txt**

Create `llms.txt` (repo root), following the llms.txt convention (H1 + blockquote summary + linked sections):

```markdown
# Demo Locker

> Self-hosted music streaming, an embeddable player for your own website, and private demo sharing with timestamped comments — one MIT-licensed app you run yourself. One container, zero external services: `docker run -d -v demolocker:/data -p 3001:3001 ghcr.io/usedrobot/demo-locker:latest`.

## Setup (for agents)

- [AGENTS.md](AGENTS.md): deployment runbook — three hosting paths plus a full API-only bootstrap (account, upload, publish, embed) with verification for every step

## Docs

- [docs/embed.md](docs/embed.md): the embeddable player and the public read-only API (the SDK surface)
- [docs/host-your-music.md](docs/host-your-music.md): beginner hosting guide (home/$0, VPS/$5, PaaS)
- [docs/self-hosting.md](docs/self-hosting.md): Postgres + S3 deployment
- [docs/deploy-templates.md](docs/deploy-templates.md): Fly.io / Railway / Coolify
- [docs/openapi.json](docs/openapi.json): OpenAPI 3.1 description of the full API (also served by every instance at /openapi.json)

## Project

- Repo: https://github.com/usedrobot/demo-locker — MIT license
```

- [ ] **Step 4: Read both end-to-end as review** (voice consistent, phrases present, no broken links — AGENTS.md and docs/openapi.json will exist by branch end; note them as forward references in the commit message)

- [ ] **Step 5: Commit**

```bash
git add README.md llms.txt
git commit -m "docs: reframe README around the three funnel identities + llms.txt agent map"
```

---

### Task 2: OpenAPI description served at /openapi.json

**Files:**
- Create: `docs/openapi.json`
- Modify: `packages/api/src/types.ts` (add `OPENAPI_JSON?: string`)
- Modify: `packages/api/src/index.ts` (route)
- Modify: `packages/api/src/server.ts` (load file into binding)
- Modify: `packages/api/package.json` (deploy script: copy into assets dir)
- Modify: `Dockerfile` (COPY into `api` and `standalone` stages)
- Modify: `scripts/smoke.sh` (one assertion)
- Test: `packages/api/src/routes/openapi.test.ts` (small)

**Interfaces:**
- Consumes: the `/embed.js` serving pattern (Reference facts).
- Produces: `GET /openapi.json` → 200 `application/json` on Node/standalone; asset-served on Worker.

- [ ] **Step 1: Write the failing route test**

Create `packages/api/src/routes/openapi.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import app from "../index.js";

describe("GET /openapi.json", () => {
  it("serves the binding content as JSON", async () => {
    const res = await app.request("/openapi.json", {}, { OPENAPI_JSON: '{"openapi":"3.1.0"}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect((await res.json()).openapi).toBe("3.1.0");
  });

  it("404s cleanly when the binding is absent", async () => {
    const res = await app.request("/openapi.json", {}, {});
    expect(res.status).toBe(404);
  });
});
```

Run `npm test -w packages/api` — expect the new file to FAIL (404 on the first case).

- [ ] **Step 2: Implement the route + bindings**

`types.ts` Bindings: add `OPENAPI_JSON?: string;`

`index.ts`, next to the `/embed.js` route (mirror its comment about Worker assets-first divergence):

```ts
app.get("/openapi.json", (c) => {
  if (!c.env.OPENAPI_JSON) {
    return c.text("openapi description not available on this deployment", 404);
  }
  return new Response(c.env.OPENAPI_JSON, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
```

`server.ts`, alongside the embed load: `OPENAPI_PATH` env, default `"../../docs/openapi.json"` (relative to packages/api cwd), `existsSync`/`readFileSync`, log `openapi: serving <path>` / `openapi: not serving (...)`, add `OPENAPI_JSON` to bindings.

Run the test — PASS. `npm run typecheck` — clean.

- [ ] **Step 3: Write docs/openapi.json**

OpenAPI 3.1, JSON. **Read every route file while writing — the code is the source of truth**: `routes/auth.ts`, `playlists.ts`, `tracks.ts`, `comments.ts`, `shares.ts`, `public.ts`, plus `lib/limits.ts` for limit errors. Cover: `/health`; auth signup/login/me/logout; playlists list/create/get/patch(incl. `isPublic`)/delete/reorder/artwork get+post; tracks upload (multipart fields exactly as the code reads them)/stream (Range + `?token=`)/delete; comments create/read(track,playlist)/resolve/delete; shares (whatever routes exist — read `shares.ts`); all three `/public/v1` endpoints; `/embed.js` and `/openapi.json` themselves (as text/javascript and application/json responses). Document per gated endpoint: bearer or `?token=`; 404 non-enumerability in the description. Use `components.securitySchemes` (http bearer) + a `tokenQuery` apiKey-in-query scheme for media routes.

Validate: `npx --yes @redocly/cli@latest lint docs/openapi.json` (or `npx --yes swagger-cli validate docs/openapi.json` if redocly is unavailable). Must pass with zero errors (warnings acceptable — report them).

Spot-check against reality (zero-dep boot): run signup/playlist-create/public-metadata curls and diff the real response keys against the documented schemas for those three. Fix the doc where it disagrees.

- [ ] **Step 4: Wire the deploy targets**

- `packages/api/package.json` deploy script: `npm --prefix ../player run build && cp ../../docs/openapi.json ../player/dist/openapi.json && wrangler deploy`
- `Dockerfile`: in BOTH the `api` and `standalone` stages, after the existing COPYs: `COPY docs/openapi.json docs/openapi.json` (lands at `/app/docs/openapi.json`, matching the server default path).
- `scripts/smoke.sh`, after the embed.js check:

```bash
echo "→ openapi served"
curl -fsS -o /dev/null -w '%{content_type}' "$BASE/openapi.json" | grep -q json || { echo "FAIL: openapi.json"; exit 1; }
```

- [ ] **Step 5: Verify**

```bash
npm test -w packages/api && npm run typecheck && ./scripts/smoke.sh
```

All green (smoke includes the new assertion, exercising the Dockerfile COPY end-to-end).

- [ ] **Step 6: Commit**

```bash
git add docs/openapi.json packages/api Dockerfile scripts/smoke.sh
git commit -m "feat: OpenAPI 3.1 description served at /openapi.json on every deploy target"
```

---

### Task 3: AGENTS.md — the operator-agent runbook

**Files:**
- Create: `AGENTS.md`
- Modify: `docs/embed.md`, `docs/self-hosting.md` (one cross-link line each, if not already linking)

**Interfaces:**
- Consumes: everything on the branch; `scripts/smoke.sh` as the authoritative API flow; the spec's AGENTS.md section as the required structure.

- [ ] **Step 1: Write AGENTS.md per the spec's structure**

Sections, in order: What you're deploying / Path 1 standalone Docker (with the four expected boot-log lines and `curl /health` verification) / Path 2 Fly-Railway-Coolify pointer / Path 3 compose+Postgres+S3 pointer (with the `VITE_API_URL` build-arg warning) / **API-only bootstrap runbook** / Troubleshooting (incl. the volume-backup tar command from docs/host-your-music.md).

Runbook requirements: every step is a fenced command with an "expect:" line showing the success signal (exact JSON keys or status code), and jq extraction for values the next step needs. The flow: signup → token; create playlist → id; upload (multipart: `file`, `playlistId`, optional `title`) → track id; PATCH isPublic true; GET public metadata; print the two-line embed snippet with the instance origin substituted. State the three auth rules (bearer header; `?token=` for media; non-enumerable 404s mean "check your token before assuming the resource is missing"). Copy shapes from the route code and smoke.sh — not from memory.

- [ ] **Step 2: Execute the runbook end-to-end (the verification IS the test)**

Boot a fresh zero-dep server (`rm -rf /tmp/dl-agents && DATA_DIR=/tmp/dl-agents npx tsx src/server.ts` from packages/api, with player + web built), then run EVERY command block in AGENTS.md exactly as written, in order. Each expect-line must match reality. Fix the doc where it doesn't. Capture the full transcript in the task report. Kill the server after.

- [ ] **Step 3: Cross-links**

- `docs/embed.md`: add a line near the top pointing agents to AGENTS.md for setup.
- `docs/self-hosting.md`: same, one line.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/embed.md docs/self-hosting.md
git commit -m "docs: AGENTS.md operator runbook — verified end-to-end against a live instance"
```

---

## Completion

Final whole-branch review (per subagent-driven-development), then PR to main titled "Agent readiness: AGENTS.md runbook, README reframing, llms.txt, /openapi.json". Reminder for the controller: NO migrations on this branch, so no prod-Neon step is needed before merge — but state that explicitly in the PR body so the checklist habit forms.

## Self-Review (completed at plan time)

- Spec coverage: AGENTS.md structure+verification (T3), README phrases (T1), llms.txt contents (T1), openapi.json + `/openapi.json` on all targets + smoke (T2), acceptance criteria mapped (runbook executed live = T3 Step 2; validator + spot-check = T2 Step 3).
- No placeholders; code steps carry code; doc steps carry required content lists and verbatim-phrase requirements.
- Type consistency: `OPENAPI_JSON?: string` used identically in test/route/server steps; paths consistent (`/app/docs/openapi.json` ↔ default `../../docs/openapi.json` from `/app/packages/api`).
