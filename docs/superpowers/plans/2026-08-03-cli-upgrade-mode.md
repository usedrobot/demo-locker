# CLI Upgrade Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npx demo-locker --upgrade`, which moves an existing Cloudflare or Docker instance to the version of the CLI being run, without creating any resources.

**Architecture:** Discovery runs *before* planning, as async probes over the injected `Runner`, because the existing `run-capture` step kind hardcodes D1-id extraction and cannot parse arbitrary output. Discovery yields a `DiscoveredInstance`, a pure `buildUpgradePlan()` turns that into the same `Step[]` the installer already produces, and the existing `executePlan()` runs it unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest, `node:util` `parseArgs`.

## Global Constraints

- **The version installed is the CLI version being run.** Assets ship in the tarball. There is no flag to choose a target version.
- **`--upgrade` conflicts with `--mode`, `--storage`, `--port`, `--volume`.** Passing them together is an error, not a silent ignore.
- **`--worker-name`, `--d1-name`, `--r2-bucket`, `--domain` are overrides on upgrade,** not conflicts. Any supplied value is used as-is and skips discovery for that field. A subset is allowed.
- **Ambiguity is never resolved silently.** Multiple candidates under `--yes` or `--dry-run` is a hard error listing them.
- **Cloudflare: `d1 migrations apply` MUST precede `wrangler deploy`.** The ORM selects every column explicitly, so a Worker ahead of its migration breaks all reads of any table that gained a column.
- **Docker: `-v` must never appear in a `docker rm` argument list.** It deletes the volume holding the user's audio.
- **`num_tables` from `wrangler d1 list --json` is unusable for identification** — it reports `0` for live, serving databases (verified 2026-08-03).
- No backup step. No rollback wrapper. No state file.
- All new files are ESM with `.js` import specifiers, matching the package.

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/discover.ts` (new) | Pure output parsers + async probes; resolves flags/probes into one `DiscoveredInstance` |
| `packages/cli/src/upgrade.ts` (new) | `buildUpgradePlan()` — pure, `DiscoveredInstance` → `DeployPlan` |
| `packages/cli/src/execute.ts` | Add `mkdtemp` / `rmDir` to `Runner` |
| `packages/cli/src/questions.ts` | `--upgrade` flag, conflict validation |
| `packages/cli/src/main.ts` | USAGE text, upgrade branch |
| `packages/cli/test/discover.test.ts` (new) | Parser + resolution tests |
| `packages/cli/test/upgrade.test.ts` (new) | Plan shape + the two data-loss guards |
| `packages/cli/test/main.test.ts` | `--upgrade` in the documented-flags list |
| `docs/upgrading.md`, `AGENTS.md` | Document the supported command |

---

### Task 1: `--upgrade` flag and conflict validation

**Files:**
- Modify: `packages/cli/src/questions.ts` (the `Flags` interface, `parseFlags`)
- Modify: `packages/cli/src/main.ts` (USAGE)
- Modify: `packages/cli/test/main.test.ts` (documented-flags list)
- Test: `packages/cli/test/questions.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Flags.upgrade: boolean`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/questions.test.ts`:

```ts
describe("--upgrade flag", () => {
  it("parses as a boolean, defaulting false", () => {
    expect(parseFlags([]).upgrade).toBe(false);
    expect(parseFlags(["--upgrade"]).upgrade).toBe(true);
  });

  it("rejects install-only flags alongside --upgrade", () => {
    for (const bad of [
      ["--upgrade", "--mode", "instance"],
      ["--upgrade", "--storage", "local"],
      ["--upgrade", "--port", "3001"],
      ["--upgrade", "--volume", "demolocker"],
    ]) {
      expect(() => parseFlags(bad), bad.join(" ")).toThrow(/--upgrade/);
    }
  });

  it("allows the naming flags as overrides", () => {
    const f = parseFlags([
      "--upgrade", "--worker-name", "w", "--d1-name", "d",
      "--r2-bucket", "r", "--domain", "h", "--target", "cloudflare",
    ]);
    expect(f.upgrade).toBe(true);
    expect(f.workerName).toBe("w");
    expect(f.d1Name).toBe("d");
    expect(f.r2Bucket).toBe("r");
    expect(f.domain).toBe("h");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/cli -- questions`
Expected: FAIL — `upgrade` is not a property of `Flags`.

- [ ] **Step 3: Implement**

In `packages/cli/src/questions.ts`, add to the `Flags` interface (beside `yes` / `dryRun`):

```ts
  upgrade: boolean;
```

Add to the `options` map inside `parseFlags`:

```ts
      upgrade: { type: "boolean", default: false },
```

Then, in `parseFlags`, after the values are read and before the `Flags` object is returned, add:

```ts
  // Install-only flags describe resources to CREATE. On upgrade every one of
  // them is already fixed by the running instance, so accepting them would
  // silently imply we can change something we cannot.
  if (v.upgrade) {
    const installOnly = ["mode", "storage", "port", "volume"] as const;
    const offenders = installOnly.filter((k) => v[k] !== undefined);
    if (offenders.length > 0) {
      throw new Error(
        `--upgrade cannot be combined with: ${offenders.map((o) => `--${o}`).join(", ")}. ` +
          `Those describe a new install; an upgrade reuses what the instance already has.`,
      );
    }
  }
```

And include `upgrade: v.upgrade ?? false,` in the returned object.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w packages/cli -- questions`
Expected: PASS.

- [ ] **Step 5: Add to USAGE and its guard test**

In `packages/cli/src/main.ts` USAGE, directly above the `--yes` line:

```
  --upgrade                       update an existing instance in place
```

In `packages/cli/test/main.test.ts`, add `"--upgrade",` to the `flags` array in the "documents every flag" test.

- [ ] **Step 6: Run the full CLI suite and commit**

Run: `npm test -w packages/cli`
Expected: PASS.

```bash
git add packages/cli/src/questions.ts packages/cli/src/main.ts packages/cli/test
git commit -m "feat(cli): add --upgrade flag with install-flag conflict validation"
```

---

### Task 2: Runner gains temp-directory support

**Files:**
- Modify: `packages/cli/src/execute.ts`
- Test: `packages/cli/test/execute.test.ts`

**Interfaces:**
- Produces: `Runner.mkdtemp(prefix: string): Promise<string>`, `Runner.rmDir(path: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/execute.test.ts`:

```ts
describe("Runner temp directories", () => {
  it("defaultRunner creates a real directory and removes it", async () => {
    const { io } = fakeIO();
    const r = defaultRunner(io);
    const dir = await r.mkdtemp("demo-locker-test-");
    const { existsSync } = await import("node:fs");
    expect(existsSync(dir)).toBe(true);
    await r.rmDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
```

Add `defaultRunner` to the existing import from `../src/execute.js`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/cli -- execute`
Expected: FAIL — `r.mkdtemp is not a function`.

- [ ] **Step 3: Implement**

In `packages/cli/src/execute.ts`, extend the imports:

```ts
import { cp, writeFile as fsWriteFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Add to the `Runner` interface:

```ts
  mkdtemp(prefix: string): Promise<string>;
  rmDir(path: string): Promise<void>;
```

Add to the object returned by `defaultRunner`:

```ts
    mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    rmDir: (path) => rm(path, { recursive: true, force: true }),
```

- [ ] **Step 4: Update the test fake**

In `packages/cli/test/execute.test.ts`, add to `fakeRunner`'s returned object (before `...overrides`):

```ts
    mkdtemp: vi.fn(async (prefix: string) => `/tmp/${prefix}fake`),
    rmDir: vi.fn(async () => {}),
```

- [ ] **Step 5: Run to verify pass, then commit**

Run: `npm test -w packages/cli`
Expected: PASS.

```bash
git add packages/cli/src/execute.ts packages/cli/test/execute.test.ts
git commit -m "feat(cli): add mkdtemp/rmDir to Runner for upgrade staging"
```

---

### Task 3: Cloudflare discovery parsing

**Files:**
- Create: `packages/cli/src/discover.ts`
- Test: `packages/cli/test/discover.test.ts`

**Interfaces:**
- Produces: `type CloudflareCandidate`, `parseD1List(stdout: string)`, `workerNameFromD1(d1Name: string)`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/discover.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseD1List, workerNameFromD1 } from "../src/discover.js";

const D1_JSON = JSON.stringify([
  { uuid: "ca6096da-2ca9-4dfa-ba22-5f154cc0a322", name: "demo-locker-dlisok-db", num_tables: 0 },
  { uuid: "0ea573b2-861c-482c-a9c7-de5335d29fa0", name: "demo-locker-db", num_tables: 6 },
  { uuid: "11111111-2222-3333-4444-555555555555", name: "unrelated-thing", num_tables: 2 },
]);

describe("parseD1List", () => {
  it("reads name and uuid for every database", () => {
    expect(parseD1List(D1_JSON)).toEqual([
      { name: "demo-locker-dlisok-db", id: "ca6096da-2ca9-4dfa-ba22-5f154cc0a322" },
      { name: "demo-locker-db", id: "0ea573b2-861c-482c-a9c7-de5335d29fa0" },
      { name: "unrelated-thing", id: "11111111-2222-3333-4444-555555555555" },
    ]);
  });

  it("ignores wrangler banner lines before the JSON", () => {
    const noisy = " ⛅️ wrangler 4.20.4\n----------------\n" + D1_JSON;
    expect(parseD1List(noisy)).toHaveLength(3);
  });

  it("returns [] rather than throwing on unparseable output", () => {
    expect(parseD1List("not json at all")).toEqual([]);
  });

  // num_tables reports 0 for a live, serving database — verified 2026-08-03
  // against demo-locker-dlisok-db. Nothing may filter on it.
  it("does not use num_tables to filter", () => {
    const names = parseD1List(D1_JSON).map((d) => d.name);
    expect(names).toContain("demo-locker-dlisok-db");
  });
});

describe("workerNameFromD1", () => {
  it("strips the -db suffix", () => {
    expect(workerNameFromD1("demo-locker-dlisok-db")).toBe("demo-locker-dlisok");
    expect(workerNameFromD1("demo-locker-db")).toBe("demo-locker");
  });

  it("returns null when the name does not end in -db", () => {
    expect(workerNameFromD1("unrelated-thing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/cli -- discover`
Expected: FAIL — cannot resolve `../src/discover.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/discover.ts`:

```ts
// Finding an instance that already exists.
//
// Discovery runs before planning, not as plan steps: `run-capture` in
// execute.ts hardcodes D1-id extraction and cannot parse arbitrary output.
// These probes take the injected Runner so they stay testable without a real
// account or daemon.

import type { Runner } from "./execute.js";

export interface CloudflareCandidate {
  target: "cloudflare";
  workerName: string;
  d1Name: string;
  d1Id: string;
  r2Bucket: string | null;
  domain: string | null;
}

/**
 * `wrangler d1 list --json` prints a banner before the JSON, so slice from the
 * first bracket. Returns [] on anything unparseable — a discovery probe that
 * throws would abort an upgrade over a wrangler version cosmetic.
 */
export function parseD1List(stdout: string): Array<{ name: string; id: string }> {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  try {
    const rows = JSON.parse(stdout.slice(start)) as Array<{ name?: string; uuid?: string }>;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => typeof r.name === "string" && typeof r.uuid === "string")
      .map((r) => ({ name: r.name as string, id: r.uuid as string }));
  } catch {
    return [];
  }
}

/**
 * The installer names the database `<worker>-db`, so the Worker name is the
 * database name minus that suffix. Verified against `deployments list` before
 * it is trusted — this is a candidate, not an answer.
 */
export function workerNameFromD1(d1Name: string): string | null {
  return d1Name.endsWith("-db") ? d1Name.slice(0, -"-db".length) : null;
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npm test -w packages/cli -- discover`
Expected: PASS.

```bash
git add packages/cli/src/discover.ts packages/cli/test/discover.test.ts
git commit -m "feat(cli): parse wrangler d1 list for upgrade discovery"
```

---

### Task 4: Docker discovery parsing

**Files:**
- Modify: `packages/cli/src/discover.ts`
- Test: `packages/cli/test/discover.test.ts`

**Interfaces:**
- Produces: `type DockerCandidate`, `parseDockerInspect(stdout: string, containerId: string)`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/discover.test.ts`:

```ts
import { parseDockerInspect } from "../src/discover.js";

const INSPECT_JSON = JSON.stringify([
  {
    Id: "abc123def456",
    Name: "/demolocker",
    Config: {
      Image: "ghcr.io/usedrobot/demo-locker:latest",
      Env: [
        "PATH=/usr/local/bin",
        "NODE_VERSION=22.11.0",
        "DATA_DIR=/data",
        "ALLOW_SIGNUP=true",
        "S3_BUCKET=demos",
      ],
    },
    Mounts: [{ Type: "volume", Name: "demolocker", Destination: "/data" }],
    NetworkSettings: { Ports: { "3001/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] } },
  },
]);

describe("parseDockerInspect", () => {
  it("reads the /data volume, published port and app env", () => {
    expect(parseDockerInspect(INSPECT_JSON, "abc123def456")).toEqual({
      target: "docker",
      containerId: "abc123def456",
      containerName: "demolocker",
      volume: "demolocker",
      port: 8080,
      env: ["DATA_DIR=/data", "ALLOW_SIGNUP=true", "S3_BUCKET=demos"],
    });
  });

  // Carrying PATH or NODE_VERSION into `docker run` would override the image's
  // own values and can break the container outright.
  it("drops env the image sets for itself", () => {
    const env = parseDockerInspect(INSPECT_JSON, "abc123def456")!.env;
    expect(env).not.toContain("PATH=/usr/local/bin");
    expect(env.some((e) => e.startsWith("NODE_VERSION"))).toBe(false);
  });

  it("returns null when there is no /data volume to reuse", () => {
    const noVolume = JSON.stringify([
      { Id: "x", Name: "/x", Config: { Image: "i", Env: [] }, Mounts: [], NetworkSettings: { Ports: {} } },
    ]);
    expect(parseDockerInspect(noVolume, "x")).toBeNull();
  });

  it("returns null on unparseable output", () => {
    expect(parseDockerInspect("nope", "x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/cli -- discover`
Expected: FAIL — `parseDockerInspect` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/cli/src/discover.ts`:

```ts
export interface DockerCandidate {
  target: "docker";
  containerId: string;
  containerName: string;
  volume: string;
  port: number;
  env: string[];
}

/**
 * Environment the APP owns. Everything else in Config.Env belongs to the image
 * (PATH, NODE_VERSION, …) and re-passing it to `docker run` would override the
 * new image's own values.
 */
const APP_ENV_PREFIXES = [
  "DATA_DIR", "PORT", "ALLOW_SIGNUP", "MAX_UPLOAD_BYTES", "MAX_STORAGE_BYTES",
  "MAX_PLAYLISTS", "MAX_COLLABORATORS", "S3_",
];

/**
 * Read back everything needed to recreate the container faithfully. An instance
 * on a non-default port, or with S3 credentials or ALLOW_SIGNUP set, must come
 * back up with exactly those — so they are read, never reconstructed from
 * defaults. Returns null if there is no /data volume, because without one there
 * is no instance to preserve and recreating would produce an empty locker.
 */
export function parseDockerInspect(stdout: string, containerId: string): DockerCandidate | null {
  const start = stdout.indexOf("[");
  if (start === -1) return null;
  let row: {
    Name?: string;
    Config?: { Env?: string[] };
    Mounts?: Array<{ Name?: string; Destination?: string }>;
    NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null> };
  };
  try {
    const parsed = JSON.parse(stdout.slice(start));
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    row = parsed[0];
  } catch {
    return null;
  }

  const dataMount = (row.Mounts ?? []).find((m) => m.Destination === "/data");
  if (!dataMount?.Name) return null;

  const bindings = row.NetworkSettings?.Ports ?? {};
  const hostPort = Object.values(bindings).flatMap((b) => b ?? [])[0]?.HostPort;
  const port = Number(hostPort);

  return {
    target: "docker",
    containerId,
    containerName: (row.Name ?? "").replace(/^\//, ""),
    volume: dataMount.Name,
    port: Number.isInteger(port) && port > 0 ? port : 3001,
    env: (row.Config?.Env ?? []).filter((e) => APP_ENV_PREFIXES.some((p) => e.startsWith(p))),
  };
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npm test -w packages/cli -- discover`
Expected: PASS.

```bash
git add packages/cli/src/discover.ts packages/cli/test/discover.test.ts
git commit -m "feat(cli): parse docker inspect for upgrade discovery"
```

---

### Task 5: Probe orchestration and ambiguity resolution

**Files:**
- Modify: `packages/cli/src/discover.ts`
- Test: `packages/cli/test/discover.test.ts`

**Interfaces:**
- Consumes: `parseD1List`, `workerNameFromD1`, `parseDockerInspect`, `Runner`
- Produces: `type DiscoveredInstance = DockerCandidate | CloudflareCandidate`, `probeDocker(runner)`, `probeCloudflare(runner)`, `resolveInstance(opts, runner)` returning `{ ok: true; instance } | { ok: false; reason: string; candidates: string[] }`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/discover.test.ts`:

```ts
import { vi } from "vitest";
import { resolveInstance } from "../src/discover.js";
import type { Runner } from "../src/execute.js";

function runnerWith(responses: Record<string, string>): Runner {
  return {
    exec: vi.fn(async () => 0),
    execCapture: vi.fn(async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      const match = Object.keys(responses).find((k) => key.startsWith(k));
      return match ? { code: 0, stdout: responses[match] } : { code: 1, stdout: "" };
    }),
    writeFile: vi.fn(async () => {}),
    copyDir: vi.fn(async () => {}),
    mkdtemp: vi.fn(async () => "/tmp/x"),
    rmDir: vi.fn(async () => {}),
    fetchFn: vi.fn() as unknown as typeof fetch,
    sleep: async () => {},
  };
}

describe("resolveInstance", () => {
  it("uses explicit flags without probing at all", async () => {
    const runner = runnerWith({});
    const res = await resolveInstance(
      { target: "cloudflare", workerName: "w", d1Name: "d", r2Bucket: "r", domain: "h" },
      runner,
    );
    expect(res.ok).toBe(true);
    expect(runner.execCapture).not.toHaveBeenCalled();
  });

  it("finds a single docker instance", async () => {
    const runner = runnerWith({
      "docker ps": "abc123def456\n",
      "docker inspect": INSPECT_JSON,
    });
    const res = await resolveInstance({}, runner);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.instance).toMatchObject({ target: "docker", volume: "demolocker" });
  });

  it("errors, listing candidates, when docker and cloudflare both match", async () => {
    const runner = runnerWith({
      "docker ps": "abc123def456\n",
      "docker inspect": INSPECT_JSON,
      "npx wrangler d1 list": D1_JSON,
      "npx wrangler deployments list": "ok",
      "npx wrangler r2 bucket list": "demo-locker-dlisok-demos",
    });
    const res = await resolveInstance({}, runner);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.candidates.length).toBeGreaterThan(1);
  });

  it("errors with a useful reason when nothing is found", async () => {
    const res = await resolveInstance({}, runnerWith({}));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/docker/i);
      expect(res.reason).toMatch(/cloudflare/i);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/cli -- discover`
Expected: FAIL — `resolveInstance` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/cli/src/discover.ts`:

```ts
import { IMAGE } from "./plan.js";

export type DiscoveredInstance = DockerCandidate | CloudflareCandidate;

export interface ResolveOptions {
  target?: "cloudflare" | "docker" | "existing";
  workerName?: string;
  d1Name?: string;
  r2Bucket?: string;
  domain?: string;
}

export type ResolveResult =
  | { ok: true; instance: DiscoveredInstance }
  | { ok: false; reason: string; candidates: string[] };

const IMAGE_NAME = IMAGE.split(":")[0];

export async function probeDocker(runner: Runner): Promise<DockerCandidate[]> {
  const { code, stdout } = await runner.execCapture("docker", [
    "ps", "-a", "--filter", `ancestor=${IMAGE_NAME}`, "--format", "{{.ID}}",
  ]);
  if (code !== 0) return [];
  const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const found: DockerCandidate[] = [];
  for (const id of ids) {
    const res = await runner.execCapture("docker", ["inspect", id]);
    if (res.code !== 0) continue;
    const c = parseDockerInspect(res.stdout, id);
    if (c) found.push(c);
  }
  return found;
}

export async function probeCloudflare(runner: Runner): Promise<CloudflareCandidate[]> {
  const list = await runner.execCapture("npx", ["wrangler", "d1", "list", "--json"]);
  if (list.code !== 0) return [];
  const buckets = await runner.execCapture("npx", ["wrangler", "r2", "bucket", "list"]);

  const found: CloudflareCandidate[] = [];
  for (const db of parseD1List(list.stdout)) {
    const workerName = workerNameFromD1(db.name);
    if (!workerName) continue;
    // A derived name is a guess until the Worker is confirmed to exist.
    const check = await runner.execCapture("npx", ["wrangler", "deployments", "list", "--name", workerName]);
    if (check.code !== 0) continue;
    const bucket = `${workerName}-demos`;
    found.push({
      target: "cloudflare",
      workerName,
      d1Name: db.name,
      d1Id: db.id,
      r2Bucket: buckets.code === 0 && buckets.stdout.includes(bucket) ? bucket : null,
      domain: null,
    });
  }
  return found;
}

/**
 * Explicit flags win outright and skip probing. Otherwise probe both targets;
 * exactly one hit resolves, anything else is an error that names the
 * candidates. Nothing here ever picks on the user's behalf — an upgrade writes
 * to something that already exists and holds data.
 */
export async function resolveInstance(opts: ResolveOptions, runner: Runner): Promise<ResolveResult> {
  if (opts.target === "cloudflare" && opts.workerName) {
    return {
      ok: true,
      instance: {
        target: "cloudflare",
        workerName: opts.workerName,
        d1Name: opts.d1Name ?? `${opts.workerName}-db`,
        d1Id: "",
        r2Bucket: opts.r2Bucket ?? `${opts.workerName}-demos`,
        domain: opts.domain ?? null,
      },
    };
  }

  const docker = opts.target === "cloudflare" ? [] : await probeDocker(runner);
  const cloud = opts.target === "docker" ? [] : await probeCloudflare(runner);
  const all: DiscoveredInstance[] = [...docker, ...cloud];

  if (all.length === 1) return { ok: true, instance: all[0] };
  if (all.length === 0) {
    return {
      ok: false,
      candidates: [],
      reason:
        `No Demo Locker instance found.\n` +
        `  docker:     looked for a container from ${IMAGE_NAME}\n` +
        `  cloudflare: looked for a D1 database named <worker>-db with a deployed Worker\n` +
        `If your instance runs somewhere else (Fly, Railway, a VPS), upgrade it by ` +
        `redeploying the image — see docs/upgrading.md.`,
    };
  }
  return {
    ok: false,
    candidates: all.map((c) => (c.target === "docker" ? `docker: ${c.containerName}` : `cloudflare: ${c.workerName}`)),
    reason: "More than one Demo Locker instance found. Disambiguate with --target or --worker-name.",
  };
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npm test -w packages/cli -- discover`
Expected: PASS.

```bash
git add packages/cli/src/discover.ts packages/cli/test/discover.test.ts
git commit -m "feat(cli): probe docker and cloudflare, never resolve ambiguity silently"
```

---

### Task 6: `buildUpgradePlan` — both targets, with the data-loss guards

**Files:**
- Create: `packages/cli/src/upgrade.ts`
- Test: `packages/cli/test/upgrade.test.ts`

**Interfaces:**
- Consumes: `DiscoveredInstance`, `DeployPlan`, `Step`, `wranglerConfig` behaviour from `plan.ts`
- Produces: `buildUpgradePlan(instance: DiscoveredInstance, stagingDir: string): DeployPlan`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/upgrade.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildUpgradePlan } from "../src/upgrade.js";
import type { DiscoveredInstance } from "../src/discover.js";
import type { Step } from "../src/plan.js";

const cf: DiscoveredInstance = {
  target: "cloudflare", workerName: "demo-locker-dlisok", d1Name: "demo-locker-dlisok-db",
  d1Id: "ca6096da", r2Bucket: "demo-locker-dlisok-demos", domain: "demolocker.dlisok.com",
};
const dk: DiscoveredInstance = {
  target: "docker", containerId: "abc123", containerName: "demolocker",
  volume: "demolocker", port: 8080, env: ["ALLOW_SIGNUP=true"],
};

const runs = (steps: Step[]) =>
  steps.filter((s): s is Extract<Step, { kind: "run" }> => s.kind === "run");

describe("buildUpgradePlan cloudflare", () => {
  it("applies migrations BEFORE deploying", () => {
    const args = runs(buildUpgradePlan(cf, "/tmp/stage").steps).map((s) => s.args.join(" "));
    const apply = args.findIndex((a) => a.includes("migrations apply"));
    const deploy = args.findIndex((a) => a.includes("deploy"));
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(apply).toBeLessThan(deploy);
  });

  it("writes a wrangler config naming the discovered resources", () => {
    const write = buildUpgradePlan(cf, "/tmp/stage").steps.find(
      (s): s is Extract<Step, { kind: "write" }> => s.kind === "write",
    )!;
    expect(write.contents).toContain("demo-locker-dlisok-db");
    expect(write.contents).toContain("demo-locker-dlisok-demos");
    expect(write.contents).toContain("demolocker.dlisok.com");
  });

  it("creates nothing", () => {
    const args = runs(buildUpgradePlan(cf, "/tmp/stage").steps).map((s) => s.args.join(" "));
    expect(args.some((a) => a.includes("d1 create"))).toBe(false);
    expect(args.some((a) => a.includes("r2 bucket create"))).toBe(false);
  });
});

describe("buildUpgradePlan docker", () => {
  it("never passes -v to docker rm", () => {
    for (const s of runs(buildUpgradePlan(dk, "/tmp/stage").steps)) {
      if (s.args[0] === "rm") expect(s.args).not.toContain("-v");
    }
  });

  it("reuses the existing volume, port and env verbatim", () => {
    const run = runs(buildUpgradePlan(dk, "/tmp/stage").steps).find((s) => s.args[0] === "run")!;
    expect(run.args).toContain("demolocker:/data");
    expect(run.args).toContain("8080:3001");
    expect(run.args).toContain("ALLOW_SIGNUP=true");
  });

  it("has no migration step — the image migrates on boot", () => {
    const args = runs(buildUpgradePlan(dk, "/tmp/stage").steps).map((s) => s.args.join(" "));
    expect(args.some((a) => a.includes("migrations"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/cli -- upgrade`
Expected: FAIL — cannot resolve `../src/upgrade.js`.

- [ ] **Step 3: Export the config generator from plan.ts**

In `packages/cli/src/plan.ts`, change `function wranglerConfig(` to `export function wranglerConfig(` and widen its parameter type so upgrade can call it:

```ts
export function wranglerConfig(cf: {
  workerName: string;
  d1Name: string;
  r2Bucket: string;
  domain: string | null;
}): string {
```

The body is unchanged — it already emits `"database_id": "__DATABASE_ID__"`, which the installer substitutes. Upgrade substitutes the discovered id instead (Step 4).

- [ ] **Step 4: Implement**

Create `packages/cli/src/upgrade.ts`:

```ts
// Upgrading an instance that already exists. Creates nothing.

import { join } from "node:path";
import { IMAGE, PACKAGED_ASSETS_FOR_UPGRADE, wranglerConfig } from "./plan.js";
import type { DeployPlan, Step } from "./plan.js";
import type { DiscoveredInstance } from "./discover.js";

export function buildUpgradePlan(instance: DiscoveredInstance, stagingDir: string): DeployPlan {
  return instance.target === "docker"
    ? dockerUpgrade(instance)
    : cloudflareUpgrade(instance, stagingDir);
}

function cloudflareUpgrade(
  cf: Extract<DiscoveredInstance, { target: "cloudflare" }>,
  stagingDir: string,
): DeployPlan {
  const config = wranglerConfig({
    workerName: cf.workerName,
    d1Name: cf.d1Name,
    r2Bucket: cf.r2Bucket ?? `${cf.workerName}-demos`,
    domain: cf.domain,
  }).replace("__DATABASE_ID__", cf.d1Id);

  const configPath = join(stagingDir, "wrangler.jsonc");
  const steps: Step[] = [
    { kind: "copy", title: "Stage the new build", from: PACKAGED_ASSETS_FOR_UPGRADE, to: stagingDir },
    { kind: "write", title: "Write wrangler config for this instance", path: configPath, contents: config },
    {
      kind: "run",
      title: "Check for pending migrations (read-only)",
      cmd: "npx",
      args: ["wrangler", "d1", "migrations", "list", cf.d1Name, "--remote", "--config", configPath],
    },
    // MUST precede deploy: the ORM selects every column explicitly, so a Worker
    // running ahead of its migration breaks every read of any table that
    // gained a column. Asserted by a test, not left to step order by luck.
    {
      kind: "run",
      title: "Apply migrations",
      cmd: "npx",
      args: ["wrangler", "d1", "migrations", "apply", cf.d1Name, "--remote", "--config", configPath],
    },
    {
      kind: "run",
      title: "Deploy the new version",
      cmd: "npx",
      args: ["wrangler", "deploy", "--config", configPath],
    },
  ];

  const appUrl = cf.domain ? `https://${cf.domain}` : null;
  return { steps, healthUrl: appUrl ? `${appUrl}/health` : null, appUrl };
}

function dockerUpgrade(dk: Extract<DiscoveredInstance, { target: "docker" }>): DeployPlan {
  const envArgs = dk.env.flatMap((e) => ["-e", e]);
  const steps: Step[] = [
    { kind: "run", title: "Pull the new image", cmd: "docker", args: ["pull", IMAGE] },
    { kind: "run", title: "Stop the running container", cmd: "docker", args: ["stop", dk.containerId] },
    // NEVER -v. That deletes the volume holding every uploaded master.
    { kind: "run", title: "Remove the old container", cmd: "docker", args: ["rm", dk.containerId] },
    {
      kind: "run",
      title: "Start the new container on the same volume",
      cmd: "docker",
      args: [
        "run", "-d", "--name", dk.containerName, "--restart", "unless-stopped",
        "-v", `${dk.volume}:/data`, "-p", `${dk.port}:3001`,
        ...envArgs,
        IMAGE,
      ],
    },
  ];
  const appUrl = `http://localhost:${dk.port}`;
  return { steps, healthUrl: `${appUrl}/health`, appUrl };
}
```

Then in `packages/cli/src/plan.ts`, export the packaged-assets path so upgrade can stage it:

```ts
export const PACKAGED_ASSETS_FOR_UPGRADE = PACKAGED_ASSETS;
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -w packages/cli -- upgrade && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Mutation-check both data-loss guards**

Temporarily add `"-v"` to the `docker rm` args and confirm the `-v` test fails. Restore it.
Temporarily swap the apply and deploy steps and confirm the ordering test fails. Restore them.
A test that still passes with the guard removed is not a test.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/upgrade.ts packages/cli/src/plan.ts packages/cli/test/upgrade.test.ts
git commit -m "feat(cli): build upgrade plans for the cloudflare and docker targets"
```

---

### Task 7: Wire `--upgrade` into main

**Files:**
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/main.test.ts`

**Interfaces:**
- Consumes: `resolveInstance`, `buildUpgradePlan`, `executePlan`, `renderPlan`, `Runner.mkdtemp/rmDir`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/main.test.ts`:

```ts
describe("--upgrade", () => {
  function upgradeRunner(responses: Record<string, string>) {
    const calls: string[] = [];
    return {
      calls,
      exec: vi.fn(async (cmd: string, args: string[]) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return 0;
      }),
      execCapture: vi.fn(async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(" ")}`;
        const hit = Object.keys(responses).find((k) => key.startsWith(k));
        return hit ? { code: 0, stdout: responses[hit] } : { code: 1, stdout: "" };
      }),
      writeFile: vi.fn(async () => {}),
      copyDir: vi.fn(async () => {}),
      mkdtemp: vi.fn(async () => "/tmp/stage"),
      rmDir: vi.fn(async () => {}),
      fetchFn: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      sleep: async () => {},
    };
  }

  it("exits 0 and explains when nothing is found", async () => {
    const { io, read } = fakeIO();
    const code = await main(["--upgrade", "--yes"], io, { runner: upgradeRunner({}) });
    expect(code).toBe(1);
    expect(read()).toContain("No Demo Locker instance found");
  });

  it("--dry-run prints the plan and runs nothing", async () => {
    const { io, read } = fakeIO();
    const runner = upgradeRunner({
      "docker ps": "abc123\n",
      "docker inspect": JSON.stringify([{
        Id: "abc123", Name: "/demolocker",
        Config: { Image: "ghcr.io/usedrobot/demo-locker:latest", Env: [] },
        Mounts: [{ Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      }]),
    });
    const code = await main(["--upgrade", "--dry-run"], io, { runner });
    expect(code).toBe(0);
    expect(read()).toContain("docker");
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it("cancels without running anything when the confirm is declined", async () => {
    const { io, read, write } = fakeIO();
    const runner = upgradeRunner({
      "docker ps": "abc123\n",
      "docker inspect": JSON.stringify([{
        Id: "abc123", Name: "/demolocker",
        Config: { Image: "ghcr.io/usedrobot/demo-locker:latest", Env: [] },
        Mounts: [{ Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      }]),
    });
    const run = main(["--upgrade"], io, { runner });
    await waitForOutput(read, "Upgrade this instance?");
    write("n\n");
    expect(await run).toBe(0);
    expect(read()).toMatch(/cancelled/i);
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it("--target existing is a clean no-op", async () => {
    const { io, read } = fakeIO();
    const code = await main(["--upgrade", "--target", "existing", "--yes"], io, {
      runner: upgradeRunner({}),
    });
    expect(code).toBe(0);
    expect(read()).toMatch(/nothing to upgrade/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/cli -- main`
Expected: FAIL — `--upgrade` is ignored and falls into the install flow.

- [ ] **Step 3: Implement**

In `packages/cli/src/main.ts`, add imports:

```ts
import { resolveInstance } from "./discover.js";
import { buildUpgradePlan } from "./upgrade.js";
import { ask } from "./prompts.js";
```

Immediately after `flags = parseFlags(argv);` succeeds (before `collectAnswers`), insert:

```ts
  if (flags.upgrade) {
    return runUpgrade(flags, io, runner);
  }
```

Add this function at the end of the file:

```ts
async function runUpgrade(
  flags: Awaited<ReturnType<typeof parseFlags>>,
  io: IO,
  runner: Runner,
): Promise<number> {
  if (flags.target === "existing") {
    io.output.write(
      "--target existing points at an instance someone else runs — nothing to upgrade here.\n",
    );
    return 0;
  }

  const resolved = await resolveInstance(
    {
      target: flags.target,
      workerName: flags.workerName,
      d1Name: flags.d1Name,
      r2Bucket: flags.r2Bucket,
      domain: flags.domain,
    },
    runner,
  );

  if (!resolved.ok) {
    io.output.write(`${resolved.reason}\n`);
    for (const c of resolved.candidates) io.output.write(`  - ${c}\n`);
    return 1;
  }

  const inst = resolved.instance;
  const label =
    inst.target === "docker"
      ? `docker container "${inst.containerName}" (volume ${inst.volume})`
      : `cloudflare worker "${inst.workerName}"`;
  io.output.write(`Found: ${label}\n`);

  const stagingDir = await runner.mkdtemp("demo-locker-upgrade-");
  try {
    const plan = buildUpgradePlan(inst, stagingDir);
    if (flags.dryRun) {
      io.output.write(renderPlan(plan));
      return 0;
    }
    // Confirm before writing to something that already exists and holds data.
    // Prompting here rather than inside executePlan keeps the executor free of
    // interaction — it is used by the install path too.
    if (!flags.yes) {
      io.output.write(renderPlan(plan));
      const answer = await ask(io, "Upgrade this instance? (y/N)", "N");
      if (!/^y(es)?$/i.test(answer)) {
        io.output.write("Cancelled — nothing was changed.\n");
        return 0;
      }
    }
    return await executePlan(plan, null, io, runner);
  } finally {
    await runner.rmDir(stagingDir);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w packages/cli -- main`
Expected: PASS.

- [ ] **Step 5: Run everything and commit**

Run: `npm test -w packages/cli && npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add packages/cli/src/main.ts packages/cli/test/main.test.ts
git commit -m "feat(cli): wire --upgrade into main with dry-run and clean no-op"
```

---

### Task 8: Document the supported command

**Files:**
- Modify: `docs/upgrading.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace the manual Cloudflare runbook**

In `docs/upgrading.md`, under `## Cloudflare`, replace the opening sentence ("The install wizard only ever **creates** resources — there is no `--upgrade` mode yet…") with:

```markdown
```bash
npx demo-locker@latest --upgrade
```

It finds the instance, shows you what it found, and redeploys — applying any
pending D1 migrations first. Add `--dry-run` to see the plan without running
it, or `--target cloudflare` / `--worker-name <name>` if you run more than one.

The version you get is the version of the CLI you run: `@latest` upgrades to
latest, `@0.2.9` downgrades to 0.2.9.

<details>
<summary>Doing it by hand</summary>
```

Keep the existing manual steps inside that `<details>` block and close it with `</details>` — they remain correct and are the fallback when discovery cannot find an instance.

- [ ] **Step 2: Add the same to the standalone Docker section**

Under `## Standalone Docker image`, above the existing `docker pull` block:

```markdown
```bash
npx demo-locker@latest --upgrade
```

Recreates the container against the same volume, carrying over its port and
environment. The manual equivalent is below.
```

- [ ] **Step 3: Update the AGENTS.md upgrade section**

In `AGENTS.md`, under `## Upgrading an existing install`, replace the "use docs/upgrading.md instead" sentence with:

```markdown
```bash
npx demo-locker@latest --upgrade --yes
```

expect: exit 0, and `curl -fsS <instance>/health` returns `{"status":"ok",...}`.

Discovery refuses to guess: if more than one instance is found, this exits
non-zero and lists them rather than picking one. Disambiguate with `--target`
or `--worker-name`. Use `--dry-run` first to see the plan.
```

Keep the two existing warning bullets (migration ordering, never `-v`) — they still describe what the tool does and why.

- [ ] **Step 4: Verify the docs match reality**

Run: `npx demo-locker --help` from `packages/cli` (or `node dist/cli.js --help` after `npm run build -w packages/cli`) and confirm `--upgrade` appears.

- [ ] **Step 5: Commit**

```bash
git add docs/upgrading.md AGENTS.md
git commit -m "docs: document npx demo-locker --upgrade"
```

---

## Self-Review Notes

**Spec coverage:** flag + conflicts → Task 1; naming-flag overrides → Tasks 1, 5; temp staging dir → Tasks 2, 6, 7; Cloudflare discovery incl. the `num_tables` warning → Task 3; Docker discovery incl. env/port/volume readback → Task 4; probe-both + ambiguity-never-silent → Task 5; both plans + migration ordering + no `-v` → Task 6; `existing` no-op, `--dry-run`, preflight print → Task 7; docs → Task 8.

**Confirmation:** the spec requires one, and Task 7 implements it with the existing `ask()` from `prompts.ts`, called in `main.ts` *before* `executePlan`. A first draft of this plan deferred it on the false premise that it needed a hook inside `executePlan` — it does not, and prompting in `main` is better anyway, since the executor is shared with the install path and should stay non-interactive.

**Deferred deliberately (all in the spec's Out of Scope):** rollback, Fly/Railway/Coolify, backups, install-time state file.

**Note for the implementer on Task 7:** `waitForOutput` and the `write` handle come from `test/helpers.ts` — see the comment there about why answers must be sent only after the prompt they answer has been printed. Import them alongside `fakeIO`.
