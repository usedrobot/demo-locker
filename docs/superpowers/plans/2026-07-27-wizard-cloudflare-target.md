# Wizard Cloudflare Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `cloudflare` target to the `npx demo-locker` wizard that provisions a Worker, a D1 database, and an R2 bucket, then deploys Demo Locker — optionally on a custom domain — in one command.

**Architecture:** The wizard's existing `collectAnswers() → buildPlan() → Step[] → executePlan()` pipeline is unchanged. The Cloudflare target is a new `case` in `buildPlan` that emits `wrangler` steps, plus one new `Step` kind (`run-capture`) so the plan can read `database_id` back out of `wrangler d1 create`. The deployed Worker serves both the API and the web app from a single origin via the Workers assets binding, so there are no secrets, no CORS, and no build-time API URL.

**Tech Stack:** TypeScript (ESM, Node ≥20), vitest, `node:util` `parseArgs`, `node:readline/promises`, wrangler (invoked as a subprocess, never imported).

**Spec:** `docs/superpowers/specs/2026-07-27-wizard-cloudflare-target-design.md`

## Global Constraints

- **Prerequisite:** `feat/sqlite-d1` must be merged to `main` before Task 6. Tasks 1–5 and 7–9 do not depend on it. The D1 migration SQL that Task 6 packages lives only on that branch.
- **Node ≥20**, ESM only. All relative imports inside `packages/cli/src` end in `.js` (TypeScript ESM convention already used throughout).
- **Zero runtime dependencies** in `packages/cli`. `typescript` and `vitest` are the only devDependencies. Do not add any package.
- **`wrangler` is never imported.** It is invoked as a subprocess through `Runner`, exactly as `docker` and `fly` are today.
- **No secrets on this path.** D1 and R2 are bindings. Nothing sensitive is written to disk or printed. Do not add a secrets step.
- **Every question needs a flag.** Each interactive prompt must have a corresponding CLI flag so agents can drive the wizard headlessly. This is an established rule of the package.
- **Test commands:** `npm test -w packages/cli` (vitest), `npm run typecheck -w packages/cli`.
- **The `IO` interface** is `{ input: NodeJS.ReadableStream; output: NodeJS.WritableStream }`, exported from `src/main.ts`.
- **Test helpers** live in `packages/cli/test/helpers.ts`: `fakeIO()` returns `{ io, read, write }`, and `waitForOutput(read, substring)` sequences interactive input. Reuse them; do not write new ones.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/cli/src/questions.ts` | Flag parsing, validation, interactive question flow | Modify — target list, four new flags, cloudflare question block |
| `packages/cli/src/plan.ts` | Pure `Answers → DeployPlan` mapping | Modify — drop fly/railway, add cloudflare case, add `run-capture` Step kind, add wrangler.jsonc rendering |
| `packages/cli/src/execute.ts` | The only module that touches processes and the network | Modify — `execCapture` on `Runner`, handle `run-capture` steps |
| `packages/cli/src/main.ts` | Wiring and usage text | Modify — usage text only |
| `packages/cli/assets/` | Prebuilt deployable artifact | Create (gitignored; built at publish time) |
| `packages/cli/scripts/build-assets.sh` | Produces `assets/` from the monorepo | Create |
| `.github/workflows/publish-cli.yml` | CLI release | Modify — run the asset build before packing |
| `.env.example` | Self-host env documentation | Modify — still documents Postgres |

---

### Task 1: Prove the assets-versus-Worker routing

This task is a **manual spike, not code**. It de-risks the single assumption the whole target rests on. Do it first; if it fails, stop and report rather than continuing to Task 2.

Cloudflare serves static assets ahead of the Worker. The web app needs SPA fallback so deep links resolve, but naive SPA fallback returns `index.html` for *every* unmatched path — which would silently break `/health`, `/auth/*`, and every other Hono route. The intended fix is `assets.run_worker_first`. This task proves it works before Task 5 bakes it into generated config.

**Files:**
- Create: `/tmp/dl-routing-spike/` (throwaway, deleted at the end — not in the repo)

- [ ] **Step 1: Create the spike directory and a minimal Worker**

```bash
mkdir -p /tmp/dl-routing-spike/public && cd /tmp/dl-routing-spike
cat > worker.js <<'EOF'
export default {
  fetch(request) {
    const url = new URL(request.url);
    return new Response(JSON.stringify({ worker: true, path: url.pathname }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
EOF
cat > public/index.html <<'EOF'
<!doctype html><title>spa</title><body>SPA INDEX</body>
EOF
```

- [ ] **Step 2: Write the wrangler config under test**

```bash
cat > wrangler.jsonc <<'EOF'
{
  "name": "dl-routing-spike",
  "main": "worker.js",
  "compatibility_date": "2024-12-01",
  "assets": {
    "directory": "public",
    "not_found_handling": "single-page-application",
    "run_worker_first": [
      "/health",
      "/auth/*",
      "/playlists/*",
      "/comments/*",
      "/shares/*",
      "/tracks/*",
      "/public/v1/*"
    ]
  }
}
EOF
```

- [ ] **Step 3: Deploy the spike**

Run: `cd /tmp/dl-routing-spike && npx wrangler deploy`
Expected: a deploy URL like `https://dl-routing-spike.<subdomain>.workers.dev`

- [ ] **Step 4: Verify the Worker wins on API paths**

```bash
BASE=https://dl-routing-spike.<subdomain>.workers.dev
curl -s $BASE/health
curl -s $BASE/auth/login
curl -s $BASE/tracks/abc/stream
```

Expected: all three return the Worker's JSON (`{"worker":true,...}`), NOT `SPA INDEX`.

- [ ] **Step 5: Verify SPA fallback wins on app paths**

```bash
curl -s $BASE/
curl -s $BASE/playlist/some-id
```

Expected: `/` returns `SPA INDEX`. Note what `/playlist/some-id` returns — it is **not** in the `run_worker_first` list, so it should also return `SPA INDEX`. If it returns the Worker JSON instead, `run_worker_first` is matching more broadly than expected; record the actual behavior.

- [ ] **Step 6: Record the result and tear down**

Write the findings into the spec's "The one real technical risk" section, replacing it with what was actually observed — including the exact `run_worker_first` patterns that worked. Then:

```bash
cd /tmp/dl-routing-spike && npx wrangler delete --name dl-routing-spike
rm -rf /tmp/dl-routing-spike
```

- [ ] **Step 7: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-07-27-wizard-cloudflare-target-design.md
git commit -m "docs: record assets-vs-worker routing spike results"
```

**STOP if the spike failed.** Report to DL rather than proceeding — the alternative (serving the web app from a separate Pages project) is a different design and needs a spec revision.

---

### Task 2: Replace fly and railway with cloudflare in the target list

**Files:**
- Modify: `packages/cli/src/questions.ts:10` (`TARGETS`), `packages/cli/src/questions.ts:238-249` (the target `select`), `packages/cli/src/questions.ts:270-275` (the fly/railway signup branch)
- Modify: `packages/cli/src/plan.ts:20-42` (`FLY_TOML`), `packages/cli/src/plan.ts:70-95` (fly and railway cases)
- Test: `packages/cli/test/plan.test.ts`, `packages/cli/test/questions.test.ts`

**Interfaces:**
- Produces: `TARGETS = ["cloudflare", "docker", "existing"] as const` — Tasks 3 and 5 depend on `"cloudflare"` being a member.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/plan.test.ts`:

```ts
describe("buildPlan cloudflare target is recognized", () => {
  it("does not fall through to the empty default case", () => {
    const p = buildPlan({ ...base, target: "cloudflare", storage: null, port: 3001 });
    expect(p.steps.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/cli -- plan.test.ts`
Expected: FAIL — TypeScript rejects `"cloudflare"` as a `target` value.

- [ ] **Step 3: Update the target list**

In `packages/cli/src/questions.ts`, change line 10:

```ts
const TARGETS = ["cloudflare", "docker", "existing"] as const;
```

- [ ] **Step 4: Update the target question**

Replace the `select` call in `collectAnswers` (currently lines 238–249) with:

```ts
    target = await resolve<(typeof TARGETS)[number]>(flags.target, flags.yes, () =>
      select(io, "Where will it run?", [
        { value: "cloudflare", label: "Cloudflare (Workers + D1 + R2 — free tier, works from anywhere)" },
        { value: "docker", label: "Docker on this machine (laptop, Pi, VPS — wherever you're running this)" },
        { value: "existing", label: "I already have an instance running" },
      ], "docker"), "docker");
```

- [ ] **Step 5: Remove the fly/railway signup branch**

In `collectAnswers`, delete the `if (target === "fly" || target === "railway") { ... } else if` head (currently lines 270–275) so the chain begins directly with the `flags.email && flags.password` check:

```ts
    if (flags.email && flags.password) {
      validatePassword(flags.password);
      signup = { email: flags.email, password: flags.password };
    } else if (!flags.yes) {
```

- [ ] **Step 6: Delete the fly and railway plan cases**

In `packages/cli/src/plan.ts`, delete the `FLY_TOML` constant (lines 20–42) and both the `case "fly":` and `case "railway":` blocks (lines 70–95).

- [ ] **Step 7: Delete the fly and railway tests**

In `packages/cli/test/plan.test.ts`, delete every `describe`/`it` block referencing `target: "fly"` or `target: "railway"`. In `packages/cli/test/questions.test.ts`, delete tests asserting the fly/railway signup note or the four-choice target menu; update any surviving test that asserts the menu contents to expect the three choices above.

- [ ] **Step 8: Run the full suite**

Run: `npm test -w packages/cli && npm run typecheck -w packages/cli`
Expected: PASS. The new test from Step 1 will still fail — that is expected, Task 5 implements the case. Mark it `it.skip` with the comment `// unskipped in Task 5` and note it in the commit.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/questions.ts packages/cli/src/plan.ts packages/cli/test/
git commit -m "feat(cli): replace fly/railway targets with cloudflare"
```

---

### Task 3: Cloudflare questions and flags

**Files:**
- Modify: `packages/cli/src/questions.ts` (`Flags`, `Answers`, `parseFlags`, `collectAnswers`)
- Test: `packages/cli/test/questions.test.ts`

**Interfaces:**
- Consumes: `TARGETS` including `"cloudflare"` (Task 2).
- Produces: `Answers` gains `cloudflare: { workerName: string; d1Name: string; r2Bucket: string; domain: string | null } | null`. Task 5's `buildPlan` reads exactly these field names.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/questions.test.ts`:

```ts
import { parseFlags, collectAnswers } from "../src/questions.js";
import { fakeIO, waitForOutput } from "./helpers.js";

describe("cloudflare flags", () => {
  it("--yes fills cloudflare defaults with no domain", async () => {
    const { io } = fakeIO();
    const a = await collectAnswers(
      parseFlags(["--mode", "instance", "--target", "cloudflare", "--yes"]),
      io,
      "empty",
    );
    expect(a.cloudflare).toEqual({
      workerName: "demo-locker",
      d1Name: "demo-locker-db",
      r2Bucket: "demo-locker-demos",
      domain: null,
    });
    expect(a.storage).toBeNull();
  });

  it("accepts explicit cloudflare flags", async () => {
    const { io } = fakeIO();
    const a = await collectAnswers(
      parseFlags([
        "--mode", "instance", "--target", "cloudflare", "--yes",
        "--worker-name", "dl", "--d1-name", "dl-db",
        "--r2-bucket", "dl-demos", "--domain", "demolocker.dlisok.com",
      ]),
      io,
      "empty",
    );
    expect(a.cloudflare).toEqual({
      workerName: "dl", d1Name: "dl-db",
      r2Bucket: "dl-demos", domain: "demolocker.dlisok.com",
    });
  });

  it("rejects a --domain that is a URL rather than a hostname", () => {
    expect(() => parseFlags(["--domain", "https://demolocker.dlisok.com"]))
      .toThrow(/bare hostname/);
  });

  it("rejects --domain on a non-cloudflare target", async () => {
    const { io } = fakeIO();
    await expect(
      collectAnswers(
        parseFlags(["--mode", "instance", "--target", "docker", "--domain", "x.example.com", "--yes"]),
        io,
        "empty",
      ),
    ).rejects.toThrow(/only valid with --target cloudflare/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w packages/cli -- questions.test.ts`
Expected: FAIL — `a.cloudflare` is undefined and the flags are unrecognized.

- [ ] **Step 3: Add the flags to the `Flags` interface**

In `packages/cli/src/questions.ts`, add to `interface Flags` (after `s3Region?: string;`):

```ts
  workerName?: string;
  d1Name?: string;
  r2Bucket?: string;
  domain?: string;
```

- [ ] **Step 4: Add the field to the `Answers` interface**

Add to `interface Answers` (after `s3: ... | null;`):

```ts
  cloudflare: { workerName: string; d1Name: string; r2Bucket: string; domain: string | null } | null;
```

- [ ] **Step 5: Add the hostname validator**

Add next to `validateUrl` in `packages/cli/src/questions.ts`:

```ts
/** Validate a bare hostname (no scheme, no path, no port). Throws on invalid input. */
function validateHostname(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes("/")) {
    throw new Error(
      "must be a bare hostname, e.g. demos.example.com (not a URL)",
    );
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw)) {
    throw new Error("must be a bare hostname, e.g. demos.example.com");
  }
  return raw;
}
```

- [ ] **Step 6: Parse and validate the flags**

In `parseFlags`, add to the `options` object:

```ts
      "worker-name": { type: "string" },
      "d1-name": { type: "string" },
      "r2-bucket": { type: "string" },
      domain: { type: "string" },
```

Add validation after the existing `v.url` block:

```ts
  if (v.domain !== undefined) {
    try {
      validateHostname(v.domain);
    } catch (e) {
      throw new Error(`--domain ${(e as Error).message}`);
    }
  }
```

Add to the returned object:

```ts
    workerName: v["worker-name"],
    d1Name: v["d1-name"],
    r2Bucket: v["r2-bucket"],
    domain: v.domain,
```

- [ ] **Step 7: Initialise the answer and reject cross-target flags**

In `collectAnswers`, add alongside the other `let` declarations:

```ts
  let cloudflare: Answers["cloudflare"] = null;
```

Immediately after the target `select` (and after the existing `flags.url` consistency check), add:

```ts
    const cfFlags: [string, string | undefined][] = [
      ["domain", flags.domain], ["worker-name", flags.workerName],
      ["d1-name", flags.d1Name], ["r2-bucket", flags.r2Bucket],
    ];
    for (const [name, value] of cfFlags) {
      if (value !== undefined && target !== "cloudflare") {
        throw new Error(`--${name} is only valid with --target cloudflare`);
      }
    }
```

- [ ] **Step 8: Collect the cloudflare answers**

Immediately before the `storage = await resolve(...)` call, add:

```ts
    if (target === "cloudflare") {
      const domain = flags.domain
        ?? (flags.yes ? "" : await ask(io, "Custom domain? (blank for a workers.dev URL)", ""));
      cloudflare = {
        workerName: flags.workerName ?? "demo-locker",
        d1Name: flags.d1Name ?? "demo-locker-db",
        r2Bucket: flags.r2Bucket ?? "demo-locker-demos",
        domain: domain === "" ? null : validateHostname(domain),
      };
      port = 3001;
      volume = "demolocker";
      return { mode, target, storage: null, s3: null, cloudflare, port, volume, url: null, signup, dryRun: flags.dryRun };
    }
```

Note: this early-returns before the storage question, because on Cloudflare storage is always the R2 binding. The signup block runs *after* this point in the existing code, so move the signup collection above this insertion — cut the `if (flags.email && flags.password) { ... } else if (!flags.yes) { ... }` block from the end of the `needsInstance` body and paste it directly above the `if (target === "cloudflare")` block.

- [ ] **Step 9: Add `cloudflare: null` to the other return paths**

There are three other `return` statements in `collectAnswers` (the player-only-with-url early return, the `target === "existing"` early return, and the final return). Add `cloudflare: null` to the first two and `cloudflare` to the final one.

- [ ] **Step 10: Fix the existing test fixtures**

Every `Answers` literal in `packages/cli/test/` now needs `cloudflare: null`. Update `base` in `plan.test.ts` and any inline `Answers` objects elsewhere.

- [ ] **Step 11: Run the tests**

Run: `npm test -w packages/cli && npm run typecheck -w packages/cli`
Expected: PASS (the Task 2 skipped test stays skipped).

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src/questions.ts packages/cli/test/
git commit -m "feat(cli): cloudflare questions and flags"
```

---

### Task 4: Output-capturing runner and the `run-capture` step

**Files:**
- Modify: `packages/cli/src/plan.ts` (`Step` union), `packages/cli/src/execute.ts` (`Runner`, `defaultRunner`, `executePlan`)
- Test: `packages/cli/test/execute.test.ts`

**Interfaces:**
- Produces:
  - `Step` gains `{ kind: "run-capture"; title: string; cmd: string; args: string[]; capture: string }` — `capture` names the placeholder that later steps substitute.
  - `Runner` gains `execCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>`.
  - Task 5's cloudflare case emits a `run-capture` step whose `capture` is `"DATABASE_ID"`, then a `write` step whose `contents` contains the literal text `__DATABASE_ID__`.

**How substitution works:** `executePlan` keeps a `Map<string, string>` of captured values. After a `run-capture` step, it extracts a UUID from `stdout` and stores it under `capture`. Before every subsequent `write` step, it replaces `__<KEY>__` in `contents` with the captured value. This keeps `buildPlan` a pure function with no knowledge of process output.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/execute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { executePlan } from "../src/execute.js";
import type { Runner } from "../src/execute.js";
import { fakeIO } from "./helpers.js";

describe("run-capture", () => {
  it("captures a uuid from stdout and substitutes it into a later write", async () => {
    const { io, read } = fakeIO();
    const written: Record<string, string> = {};
    const runner: Runner = {
      exec: async () => 0,
      execCapture: async () => ({
        code: 0,
        stdout: 'database_id = "11111111-2222-3333-4444-555555555555"',
      }),
      writeFile: async (p, c) => { written[p] = c; },
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      sleep: async () => {},
    };

    const code = await executePlan(
      {
        steps: [
          { kind: "run-capture", title: "Create D1", cmd: "wrangler", args: ["d1", "create", "db"], capture: "DATABASE_ID" },
          { kind: "write", title: "Write config", path: "wrangler.jsonc", contents: '{"database_id":"__DATABASE_ID__"}' },
        ],
        healthUrl: null,
        appUrl: null,
      },
      null, io, runner,
    );

    expect(code).toBe(0);
    expect(written["wrangler.jsonc"]).toBe('{"database_id":"11111111-2222-3333-4444-555555555555"}');
    expect(read()).toContain("Create D1");
  });

  it("fails with the raw output when no uuid is present", async () => {
    const { io, read } = fakeIO();
    const runner: Runner = {
      exec: async () => 0,
      execCapture: async () => ({ code: 0, stdout: "something unexpected" }),
      writeFile: async () => {},
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      sleep: async () => {},
    };

    const code = await executePlan(
      {
        steps: [
          { kind: "run-capture", title: "Create D1", cmd: "wrangler", args: [], capture: "DATABASE_ID" },
        ],
        healthUrl: null,
        appUrl: null,
      },
      null, io, runner,
    );

    expect(code).toBe(1);
    expect(read()).toContain("something unexpected");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/cli -- execute.test.ts`
Expected: FAIL — `execCapture` is not on `Runner` and `run-capture` is not a `Step` kind.

- [ ] **Step 3: Add the step kind**

In `packages/cli/src/plan.ts`, extend the `Step` union:

```ts
export type Step =
  | { kind: "run"; title: string; cmd: string; args: string[] }
  | { kind: "run-capture"; title: string; cmd: string; args: string[]; capture: string }
  | { kind: "write"; title: string; path: string; contents: string }
  | { kind: "note"; text: string };
```

- [ ] **Step 4: Render the new kind**

In `renderPlan`, add before the `write` branch:

```ts
    if (s.kind === "run-capture") return `$ ${s.cmd} ${s.args.map(redactEnvArg).join(" ")}`;
```

- [ ] **Step 5: Add `execCapture` to the Runner**

In `packages/cli/src/execute.ts`, add to `interface Runner`:

```ts
  execCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
```

And to `defaultRunner`:

```ts
    execCapture: (cmd, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "inherit"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          const text = chunk.toString();
          stdout += text;
          process.stdout.write(text);
        });
        child.on("error", (err) =>
          reject(
            new Error(`could not run "${cmd}" — is it installed and on PATH? (${err.message})`),
          ),
        );
        child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
      }),
```

The `process.stdout.write` mirrors output so the user still sees wrangler working, matching the `stdio: "inherit"` feel of `exec`.

- [ ] **Step 6: Handle the step in executePlan**

In `executePlan`, add a captures map above the loop:

```ts
  const captured = new Map<string, string>();
```

Add a branch inside the loop, before the existing `write` branch:

```ts
    if (step.kind === "run-capture") {
      const { code, stdout } = await runner.execCapture(step.cmd, step.args);
      if (code !== 0) {
        io.output.write(`✗ step failed (${step.cmd} exited ${code}): ${step.title}\n`);
        return 1;
      }
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(stdout);
      if (!uuid) {
        io.output.write(
          `✗ could not read ${step.capture} from ${step.cmd} output:\n${stdout}\n`,
        );
        return 1;
      }
      captured.set(step.capture, uuid[0]);
      continue;
    }
```

Note the existing `io.output.write(\`→ ${step.title}\n\`)` line runs before this branch, so the title is already printed.

Then in the `write` branch, substitute before writing:

```ts
    if (step.kind === "write") {
      let contents = step.contents;
      for (const [key, value] of captured) {
        contents = contents.split(`__${key}__`).join(value);
      }
      await runner.writeFile(step.path, contents);
      continue;
    }
```

- [ ] **Step 7: Update the other test runners**

Every existing `Runner` literal in `packages/cli/test/` now needs an `execCapture`. Add `execCapture: async () => ({ code: 0, stdout: "" }),` to each.

- [ ] **Step 8: Run the tests**

Run: `npm test -w packages/cli && npm run typecheck -w packages/cli`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/plan.ts packages/cli/src/execute.ts packages/cli/test/
git commit -m "feat(cli): run-capture step kind and execCapture runner"
```

---

### Task 5: The cloudflare deploy plan

**Files:**
- Modify: `packages/cli/src/plan.ts` (new `case "cloudflare"`, new `wranglerConfig` helper)
- Test: `packages/cli/test/plan.test.ts`

**Interfaces:**
- Consumes: `Answers["cloudflare"]` (Task 3), the `run-capture` Step kind (Task 4).
- Produces: `export const ASSETS_DIR = "demo-locker"` — the directory the wizard writes into and deploys from. Task 6's asset build targets the same layout.

**`run_worker_first` patterns:** use exactly what Task 1's spike proved. The list below is the expected result; if the spike found different patterns, use those instead and note the difference in the commit message.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/plan.test.ts`:

```ts
const cfBase: Answers = {
  ...base,
  target: "cloudflare",
  storage: null,
  cloudflare: {
    workerName: "demo-locker",
    d1Name: "demo-locker-db",
    r2Bucket: "demo-locker-demos",
    domain: null,
  },
};

describe("buildPlan cloudflare", () => {
  it("emits create, capture, write, migrate, deploy in order", () => {
    const p = buildPlan(cfBase);
    expect(p.steps.map((s) => s.kind)).toEqual([
      "note", "run", "run-capture", "run", "write", "run", "run",
    ]);
  });

  it("warns about the R2 billing requirement before provisioning anything", () => {
    const p = buildPlan(cfBase);
    expect(p.steps[0]).toMatchObject({ kind: "note" });
    expect((p.steps[0] as { text: string }).text).toMatch(/billing/i);
  });

  it("captures the database id from d1 create", () => {
    const p = buildPlan(cfBase);
    const cap = p.steps.find((s) => s.kind === "run-capture")!;
    expect(cap).toMatchObject({
      cmd: "wrangler",
      args: ["d1", "create", "demo-locker-db"],
      capture: "DATABASE_ID",
    });
  });

  it("writes a wrangler config with both bindings and the id placeholder", () => {
    const p = buildPlan(cfBase);
    const write = p.steps.find((s): s is Extract<typeof p.steps[number], { kind: "write" }> => s.kind === "write")!;
    expect(write.path).toBe("demo-locker/wrangler.jsonc");
    const cfg = JSON.parse(write.contents);
    expect(cfg.d1_databases[0]).toMatchObject({
      binding: "DB", database_name: "demo-locker-db", database_id: "__DATABASE_ID__",
    });
    expect(cfg.r2_buckets[0]).toMatchObject({
      binding: "DEMOS_BUCKET", bucket_name: "demo-locker-demos",
    });
    expect(cfg.assets.directory).toBe("public");
    expect(cfg.assets.not_found_handling).toBe("single-page-application");
    expect(cfg.assets.run_worker_first).toContain("/health");
    expect(cfg.routes).toBeUndefined();
  });

  it("adds a custom_domain route when a domain is given", () => {
    const p = buildPlan({ ...cfBase, cloudflare: { ...cfBase.cloudflare!, domain: "demolocker.dlisok.com" } });
    const write = p.steps.find((s): s is Extract<typeof p.steps[number], { kind: "write" }> => s.kind === "write")!;
    const cfg = JSON.parse(write.contents);
    expect(cfg.routes).toEqual([{ pattern: "demolocker.dlisok.com", custom_domain: true }]);
    expect(p.appUrl).toBe("https://demolocker.dlisok.com");
    expect(p.healthUrl).toBe("https://demolocker.dlisok.com/health");
  });

  it("has no health url without a domain, since workers.dev is not known ahead of deploy", () => {
    const p = buildPlan(cfBase);
    expect(p.appUrl).toBeNull();
    expect(p.healthUrl).toBeNull();
  });

  it("never emits a secret", () => {
    const p = buildPlan({ ...cfBase, cloudflare: { ...cfBase.cloudflare!, domain: "d.example.com" } });
    expect(renderPlan(p)).not.toMatch(/secret|SECRET|ACCESS_KEY/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w packages/cli -- plan.test.ts`
Expected: FAIL — the cloudflare case falls through to `default` and returns zero steps.

- [ ] **Step 3: Add the config builder**

In `packages/cli/src/plan.ts`, add above `buildPlan`:

```ts
export const ASSETS_DIR = "demo-locker";

const API_PATHS = [
  "/health",
  "/auth/*",
  "/playlists/*",
  "/comments/*",
  "/shares/*",
  "/tracks/*",
  "/public/v1/*",
];

function wranglerConfig(cf: NonNullable<Answers["cloudflare"]>): string {
  const config: Record<string, unknown> = {
    name: cf.workerName,
    main: "worker.js",
    compatibility_date: "2024-12-01",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_name: cf.d1Name,
        database_id: "__DATABASE_ID__",
        migrations_dir: "migrations",
      },
    ],
    r2_buckets: [{ binding: "DEMOS_BUCKET", bucket_name: cf.r2Bucket }],
    assets: {
      directory: "public",
      not_found_handling: "single-page-application",
      run_worker_first: API_PATHS,
    },
  };
  if (cf.domain) {
    config.routes = [{ pattern: cf.domain, custom_domain: true }];
  }
  return JSON.stringify(config, null, 2) + "\n";
}
```

- [ ] **Step 4: Add the cloudflare case**

Add to the `switch` in `buildPlan`, before `case "existing"`:

```ts
    case "cloudflare": {
      const cf = a.cloudflare;
      if (!cf) return { steps: [], healthUrl: null, appUrl: null };
      const appUrl = cf.domain ? `https://${cf.domain}` : null;
      return {
        steps: [
          {
            kind: "note",
            text: "R2 storage needs billing enabled on your Cloudflare account. The free tier still applies, but a card must be on file — otherwise bucket creation fails below.",
          },
          { kind: "run", title: "Check Cloudflare login", cmd: "wrangler", args: ["whoami"] },
          {
            kind: "run-capture", title: "Create D1 database", cmd: "wrangler",
            args: ["d1", "create", cf.d1Name], capture: "DATABASE_ID",
          },
          {
            kind: "run", title: "Create R2 bucket", cmd: "wrangler",
            args: ["r2", "bucket", "create", cf.r2Bucket],
          },
          {
            kind: "write", title: "Write wrangler.jsonc",
            path: `${ASSETS_DIR}/wrangler.jsonc`, contents: wranglerConfig(cf),
          },
          {
            kind: "run", title: "Apply database migrations", cmd: "wrangler",
            args: ["d1", "migrations", "apply", cf.d1Name, "--remote", "--config", `${ASSETS_DIR}/wrangler.jsonc`],
          },
          {
            kind: "run", title: "Deploy", cmd: "wrangler",
            args: ["deploy", "--config", `${ASSETS_DIR}/wrangler.jsonc`],
          },
        ],
        healthUrl: appUrl ? `${appUrl}/health` : null,
        appUrl,
      };
    }
```

- [ ] **Step 5: Unskip the Task 2 test**

Remove the `.skip` added in Task 2 Step 8.

- [ ] **Step 6: Run the tests**

Run: `npm test -w packages/cli && npm run typecheck -w packages/cli`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/plan.ts packages/cli/test/plan.test.ts
git commit -m "feat(cli): cloudflare deploy plan — d1, r2, assets, custom domain"
```

---

### Task 6: Package the prebuilt artifact

**Requires `feat/sqlite-d1` merged** — this task copies D1 migration SQL that exists only on that branch.

**Files:**
- Create: `packages/cli/scripts/build-assets.sh`
- Modify: `packages/cli/package.json` (`files`, `scripts`), `packages/cli/.gitignore` (create if absent)
- Modify: `.github/workflows/publish-cli.yml`

**Interfaces:**
- Consumes: `ASSETS_DIR` from Task 5.
- Produces: `packages/cli/assets/` containing `worker.js`, `public/`, `migrations/`.

- [ ] **Step 1: Write the asset build script**

Create `packages/cli/scripts/build-assets.sh`:

```bash
#!/usr/bin/env bash
# Builds the prebuilt Cloudflare deployable shipped inside the npm tarball.
# Run from the repo root: bash packages/cli/scripts/build-assets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$ROOT/packages/cli/assets"

rm -rf "$OUT"
mkdir -p "$OUT/public" "$OUT/migrations"

# Worker bundle — pre-bundled so the user's machine never runs npm install.
cd "$ROOT/packages/api"
npx wrangler deploy --dry-run --outdir "$OUT/.worker-build"
mv "$OUT/.worker-build/index.js" "$OUT/worker.js"
rm -rf "$OUT/.worker-build"

# Web app, built same-origin.
cd "$ROOT"
VITE_API_URL="" npm run build -w packages/web
cp -R "$ROOT/packages/web/dist/." "$OUT/public/"

# Player bundle and API description, served as assets.
npm run build -w packages/player
cp "$ROOT/packages/player/dist/embed.js" "$OUT/public/embed.js"
cp "$ROOT/packages/api/openapi.json" "$OUT/public/openapi.json"

# D1 migrations.
cp "$ROOT/packages/api/drizzle/"*.sql "$OUT/migrations/"

echo "assets built:"
find "$OUT" -maxdepth 2 -type f | sed "s|$OUT|assets|"
```

- [ ] **Step 2: Make it executable and run it**

Run:
```bash
chmod +x packages/cli/scripts/build-assets.sh
bash packages/cli/scripts/build-assets.sh
```
Expected: prints an `assets/` listing containing `assets/worker.js`, files under `assets/public/`, and at least one `.sql` under `assets/migrations/`.

If `wrangler deploy --dry-run --outdir` emits a filename other than `index.js`, correct the `mv` line to match and note it in the commit message.

- [ ] **Step 3: Verify the worker bundle has no Node-only imports**

Run: `grep -c "better-sqlite3\|@aws-sdk" packages/cli/assets/worker.js || echo "clean"`
Expected: `clean`, or `0`. A non-zero count means the Node-only storage or database driver got bundled into the Worker — stop and report, because it will fail at deploy time.

- [ ] **Step 4: Gitignore the build output**

Create `packages/cli/.gitignore`:

```
assets/
dist/
```

- [ ] **Step 5: Ship the assets in the tarball**

In `packages/cli/package.json`, change `files` and add a script:

```json
  "files": ["dist", "assets"],
```

```json
    "build:assets": "bash scripts/build-assets.sh",
```

- [ ] **Step 6: Copy the assets at deploy time**

The plan writes `wrangler.jsonc` into `demo-locker/`, so the packaged assets must be there too. In `packages/cli/src/plan.ts`, add a `note` as the first step of the cloudflare case explaining the layout, and in `packages/cli/src/execute.ts` add a copy before the `write` branch runs. Add to `Runner`:

```ts
  copyDir(from: string, to: string): Promise<void>;
```

In `defaultRunner`:

```ts
    copyDir: async (from, to) => {
      const { cp } = await import("node:fs/promises");
      await cp(from, to, { recursive: true });
    },
```

Add a `Step` kind in `plan.ts`:

```ts
  | { kind: "copy"; title: string; from: string; to: string }
```

Handle it in `executePlan`, before the `write` branch:

```ts
    if (step.kind === "copy") {
      await runner.copyDir(step.from, step.to);
      continue;
    }
```

Render it in `renderPlan`:

```ts
    if (s.kind === "copy") return `copy ${s.from} → ${s.to}`;
```

And emit it as the first step of the cloudflare case in `buildPlan`, resolving the packaged path relative to the module:

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PACKAGED_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
```

```ts
          { kind: "copy", title: "Unpack Demo Locker", from: PACKAGED_ASSETS, to: ASSETS_DIR },
```

Place it first, before the `whoami` step.

- [ ] **Step 7: Update the plan tests for the new first step**

In `packages/cli/test/plan.test.ts`, the step-order test now expects:

```ts
    expect(p.steps.map((s) => s.kind)).toEqual([
      "copy", "note", "run", "run-capture", "run", "write", "run", "run",
    ]);
```

Add `copyDir: async () => {},` to every `Runner` literal in the test files.

- [ ] **Step 8: Build assets in the publish workflow**

In `.github/workflows/publish-cli.yml`, add a step immediately before the publish step (after `npm ci`):

```yaml
      - name: Build deployable assets
        run: bash packages/cli/scripts/build-assets.sh
```

- [ ] **Step 9: Verify the tarball contents**

Run: `cd packages/cli && npm pack --dry-run 2>&1 | grep -c assets/`
Expected: a non-zero count.

- [ ] **Step 10: Run the tests**

Run: `npm test -w packages/cli && npm run typecheck -w packages/cli`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/cli/scripts/ packages/cli/package.json packages/cli/.gitignore \
        packages/cli/src/plan.ts packages/cli/src/execute.ts packages/cli/test/ \
        .github/workflows/publish-cli.yml
git commit -m "feat(cli): package prebuilt worker, web, and migrations in the tarball"
```

---

### Task 7: Expose-to-the-internet step for the docker path

**Files:**
- Modify: `packages/cli/src/plan.ts` (docker case)
- Test: `packages/cli/test/plan.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/plan.test.ts`:

```ts
describe("docker expose guidance", () => {
  it("prints cloudflared, caddy, and lan-only options after the run step", () => {
    const p = buildPlan(base);
    const notes = p.steps.filter((s): s is Extract<typeof p.steps[number], { kind: "note" }> => s.kind === "note");
    const text = notes.map((n) => n.text).join("\n");
    expect(text).toContain("cloudflared");
    expect(text).toContain("caddy");
    expect(text.toLowerCase()).toContain("lan");
  });

  it("puts the notes after the docker run step", () => {
    const p = buildPlan(base);
    const lastRun = p.steps.map((s) => s.kind).lastIndexOf("run");
    const firstNote = p.steps.map((s) => s.kind).indexOf("note");
    expect(firstNote).toBeGreaterThan(lastRun);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w packages/cli -- plan.test.ts`
Expected: FAIL — the docker case emits no notes.

- [ ] **Step 3: Add the notes**

In `packages/cli/src/plan.ts`, add above `buildPlan`:

```ts
const EXPOSE_NOTES: Step[] = [
  { kind: "note", text: "" },
  { kind: "note", text: "To reach this from outside the machine, pick one:" },
  { kind: "note", text: "  cloudflared — free https on your own domain, no open ports:" },
  { kind: "note", text: "    brew install cloudflared   # or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" },
  { kind: "note", text: "    cloudflared tunnel login" },
  { kind: "note", text: "    cloudflared tunnel create demolocker" },
  { kind: "note", text: "    cloudflared tunnel route dns demolocker demos.example.com" },
  { kind: "note", text: "    cloudflared tunnel run --url http://localhost:PORT demolocker" },
  { kind: "note", text: "  caddy — if the machine already has a public IP and DNS:" },
  { kind: "note", text: "    caddy reverse-proxy --from demos.example.com --to localhost:PORT" },
  { kind: "note", text: "  lan only — reachable at http://<this-machine-ip>:PORT, no setup needed." },
  { kind: "note", text: "    Note: browsers treat plain http as an insecure context, which disables" },
  { kind: "note", text: "    clipboard and some upload features. https via one of the above avoids that." },
];
```

In the docker case, append the notes with the real port substituted:

```ts
          ...EXPOSE_NOTES.map((n) =>
            n.kind === "note" ? { ...n, text: n.text.replaceAll("PORT", String(a.port)) } : n,
          ),
```

Place this after the two existing `run` steps in the `steps` array.

- [ ] **Step 4: Run the tests**

Run: `npm test -w packages/cli && npm run typecheck -w packages/cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/plan.ts packages/cli/test/plan.test.ts
git commit -m "feat(cli): print expose-to-the-internet options after a docker deploy"
```

---

### Task 8: Documentation sweep

**Files:**
- Modify: `packages/cli/src/main.ts` (`USAGE`), `packages/cli/README.md`, `.env.example`, `README.md`, `docs/self-hosting.md`, `AGENTS.md`

- [ ] **Step 1: Update the usage text**

In `packages/cli/src/main.ts`, replace the `--target` and add the new flags:

```
  --target <cloudflare|docker|existing>   where the instance runs
```

Add after the `--s3-*` line:

```
  --domain <host>                 custom domain for the cloudflare target
  --worker-name --d1-name --r2-bucket   cloudflare resource names
```

- [ ] **Step 2: Fix .env.example**

Replace the Postgres block at the top of `.env.example`:

```
# Database — SQLite. On Cloudflare this is the D1 binding (no env var needed).
# On Node/Docker the database file lives at $DATA_DIR/db/demolocker.db.
DATA_DIR=/data
```

Delete the `DATABASE_URL` line entirely.

- [ ] **Step 3: Update the CLI README**

In `packages/cli/README.md`, replace every mention of Fly and Railway with the Cloudflare target, and add a short section:

```markdown
## Cloudflare

    npx demo-locker --target cloudflare --domain demos.example.com

Provisions a Worker, a D1 database, and an R2 bucket, then deploys. Requires
`wrangler` to be logged in — the wizard checks and prompts if not. R2 needs
billing enabled on the Cloudflare account (the free tier still applies, but a
card must be on file).

The custom domain must be a zone on the same Cloudflare account; wrangler
provisions the DNS record and certificate. Omit `--domain` for a
`workers.dev` URL.
```

- [ ] **Step 4: Sweep the remaining Fly and Railway mentions**

Run: `grep -rn "fly\.io\|Fly\.io\|Railway\|railway" README.md docs/ AGENTS.md packages/cli/ --exclude-dir=node_modules --exclude-dir=assets`

Update each hit. Deploy-target lists become `cloudflare | docker | existing`. Leave historical references in `docs/superpowers/` untouched — those are a record of past decisions.

- [ ] **Step 5: Run the full check**

Run: `npm run typecheck && npm run lint && npm test -w packages/cli`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: cloudflare target, drop fly/railway, fix stale postgres env"
```

---

### Task 9: Whole-branch review and PR

- [ ] **Step 1: Run every check**

```bash
npm run typecheck && npm run lint
npm test -w packages/api && npm test -w packages/player && npm test -w packages/cli
./scripts/smoke.sh
```
Expected: all pass. The smoke test covers the standalone container and is unaffected by these changes — a failure means something leaked out of `packages/cli`.

- [ ] **Step 2: Verify the built CLI end to end with a dry run**

```bash
npm run build -w packages/cli
node packages/cli/dist/cli.js --mode instance --target cloudflare \
  --domain demos.example.com --yes --dry-run
```
Expected: prints the copy, whoami, d1 create, r2 create, write, migrations apply, and deploy steps, with no secrets and no `__DATABASE_ID__` placeholder leaking into a `$` command line.

- [ ] **Step 3: Request a whole-branch review**

Use the `superpowers:requesting-code-review` skill against the full diff from the branch base.

- [ ] **Step 4: Address findings, then open the PR**

```bash
gh pr create --title "feat(cli): cloudflare target, drop fly/railway" --body "$(cat <<'EOF'
Adds a `cloudflare` target to the setup wizard: provisions Worker + D1 + R2 and
deploys, optionally on a custom domain. Drops the fly and railway targets. Adds
expose-to-the-internet guidance to the docker path.

The deployed Worker serves the API and the web app from one origin via the assets
binding, so there are no secrets, no CORS, and no build-time API URL. The
deployable is prebuilt into the npm tarball, so the user's machine never runs a
build.

No migrations. Requires a CLI release before it can be used via npx.

Spec: docs/superpowers/specs/2026-07-27-wizard-cloudflare-target-design.md
Plan: docs/superpowers/plans/2026-07-27-wizard-cloudflare-target.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Manual gate after merge (DL)

Not code — the live test of this target.

1. Cut a CLI release: bump `packages/cli/package.json`, commit on `main`, `git tag cli-vX.Y.Z`, push the tag.
2. In the Cloudflare dashboard, delete the `demolocker.dlisok.com` public hostname from the `cowboy` tunnel. **The DNS record will collide with the Worker custom domain if this is skipped.**
3. Decommission the VPS container: `docker rm -f demolocker && docker volume rm demolocker` (back the volume up first if anything in it matters).
4. Run the wizard for real:

```bash
npx demo-locker@latest --target cloudflare --domain demolocker.dlisok.com
```

5. Record every confusing or wrong moment. That list is the next spec.
