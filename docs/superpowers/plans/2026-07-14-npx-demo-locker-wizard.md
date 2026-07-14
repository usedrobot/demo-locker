# `npx demo-locker` Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interactive CLI published as the bare npm package `demo-locker` that interviews the user (what do you need / where's it running / where do tracks live / config) and spins up a working Demo Locker instance and/or wires the public player into an existing web project.

**Architecture:** New npm workspace `packages/cli`. Pure decision core (flags/answers → `DeployPlan` of steps) separated from thin I/O shells (readline prompts, child_process executor), so everything interesting is unit-testable without Docker. Zero runtime dependencies: `node:util` `parseArgs`, `node:readline/promises`, global `fetch`, `node:child_process`.

**Tech Stack:** TypeScript (tsc build to `dist/`), vitest for tests, published via a clone of the existing `publish-player.yml` trusted-publishing pipeline (tag `cli-vX.Y.Z`).

## Global Constraints

- Package name: bare `demo-locker` (reserved on npm 2026-07-07). Bin name: `demo-locker`.
- Zero runtime dependencies. devDependencies limited to `typescript` + `vitest` (match `packages/player`).
- Node engine floor: `>=20` (needs `readline/promises`, `util.parseArgs`, stable `fetch`).
- **Every interactive question must have a non-interactive flag equivalent**, and `--yes` accepts all defaults — agents must be able to drive the wizard end-to-end without a TTY.
- Standalone image: `ghcr.io/usedrobot/demo-locker:latest`, internal port `3001`, data volume mount `/data`, health endpoint `GET /health`, signup `POST /auth/signup` with `{"email","password"}` → `{token}`.
- Instance env surface (from `packages/api/src/server.ts`): `PORT`, `DATA_DIR`, `DATABASE_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `demos`), `S3_REGION` (default `auto`).
- Player embed (from `docs/embed.md`): script tag `<script src="https://your-box/embed.js"></script>` + `<demo-locker-player playlist="ID">`; npm module `@demo-locker/player` where the `instance` attribute is **required**.
- v1 deploy targets: **docker** (covers local machine, Pi, VPS — anywhere the wizard runs and Docker exists) and **fly** (runs the documented `fly launch --copy-config --no-deploy` / `fly volumes create data --size 3` / `fly deploy` sequence). **railway** prints guided instructions only (no clean headless CLI path). **existing** points the player at an already-running instance.
- Verify commands (root): `npm run typecheck && npm run lint`; package tests: `npm test -w packages/cli`.
- Repo conventions: MIT, conventional commits, feature branch + PR, CI gates merges.

---

### Task 1: Scaffold `packages/cli` workspace

**Files:**
- Modify: `package.json` (root — rename to avoid workspace name collision)
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/tsconfig.build.json`
- Create: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/main.ts`
- Test: `packages/cli/test/main.test.ts`
- Modify: `.github/workflows/ci.yml:32` (add cli test step)

**Interfaces:**
- Produces: `main(argv: string[], io: IO): Promise<number>` in `src/main.ts` — every later task hangs off this. `IO = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }`.

- [ ] **Step 1: Rename the root package**

The root `package.json` is currently named `demo-locker`, which collides with the new workspace's published name. In root `package.json` change:

```json
  "name": "demo-locker-monorepo",
```

- [ ] **Step 2: Create the workspace files**

`packages/cli/package.json`:

```json
{
  "name": "demo-locker",
  "version": "0.1.0",
  "description": "Setup wizard for Demo Locker — self-hosted music streaming for demos, mixes, and playlists your band can comment on.",
  "license": "MIT",
  "type": "module",
  "bin": { "demo-locker": "dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/usedrobot/demo-locker.git",
    "directory": "packages/cli"
  },
  "homepage": "https://github.com/usedrobot/demo-locker#readme",
  "keywords": ["self-hosted", "music", "audio", "playlist", "demo-locker", "setup", "wizard"],
  "publishConfig": { "access": "public", "provenance": true },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.1.10"
  }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`packages/cli/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "declaration": false
  },
  "include": ["src"]
}
```

Note: `@types/node` is hoisted from the root workspace install; if `typecheck` can't find `node` types, add `"@types/node": "^22.0.0"` to devDependencies.

- [ ] **Step 3: Write the failing test**

`packages/cli/test/main.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { main } from "../src/main.js";

export function fakeIO() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (c) => (text += c.toString()));
  return { io: { input, output }, read: () => text, write: (s: string) => input.write(s) };
}

describe("main", () => {
  it("--help prints usage and exits 0", async () => {
    const { io, read } = fakeIO();
    const code = await main(["--help"], io);
    expect(code).toBe(0);
    expect(read()).toContain("Usage: npx demo-locker");
    expect(read()).toContain("--mode");
  });

  it("--version prints the package version", async () => {
    const { io, read } = fakeIO();
    const code = await main(["--version"], io);
    expect(code).toBe(0);
    expect(read().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm install && npm test -w packages/cli`
Expected: FAIL — cannot resolve `../src/main.js`

- [ ] **Step 5: Write minimal implementation**

`packages/cli/src/main.ts`:

```ts
import { createRequire } from "node:module";

export interface IO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const USAGE = `Usage: npx demo-locker [options]

Sets up a Demo Locker — self-hosted music streaming for demos and mixes.

Options:
  --mode <instance|player|both>   what to set up
  --target <docker|fly|railway|existing>  where the instance runs
  --storage <local|s3>            where audio files live
  --port <n>                      host port for docker target (default 3001)
  --volume <name>                 docker volume name (default demolocker)
  --url <https://...>             existing instance URL (player/existing)
  --email <addr> --password <pw>  create the first account after boot
  --s3-endpoint --s3-bucket --s3-access-key --s3-secret-key --s3-region
  --yes                           accept defaults for unanswered questions
  --dry-run                       print the deploy plan without running it
  --help, --version
`;

export async function main(argv: string[], io: IO): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.output.write(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    const require = createRequire(import.meta.url);
    io.output.write(require("../package.json").version + "\n");
    return 0;
  }
  io.output.write(USAGE);
  return 0;
}
```

`packages/cli/src/cli.ts`:

```ts
#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2), { input: process.stdin, output: process.stdout }).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w packages/cli`
Expected: PASS (2 tests)

- [ ] **Step 7: Add cli tests to CI**

In `.github/workflows/ci.yml`, after line 32 (`- run: npm test -w packages/player`) add:

```yaml
      - run: npm test -w packages/cli
```

- [ ] **Step 8: Verify root scripts still work, commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS across all workspaces including cli

```bash
git add package.json packages/cli .github/workflows/ci.yml
git commit -m "feat(cli): scaffold demo-locker wizard workspace"
```

---

### Task 2: Prompt primitives (`ask` / `select`)

**Files:**
- Create: `packages/cli/src/prompts.ts`
- Test: `packages/cli/test/prompts.test.ts`

**Interfaces:**
- Consumes: `IO` from `src/main.ts`
- Produces: `ask(io: IO, question: string, def?: string): Promise<string>` and `select<T extends string>(io: IO, question: string, choices: {value: T; label: string}[], def: T): Promise<T>`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ask, select } from "../src/prompts.js";
import { fakeIO } from "./main.test.js";

describe("ask", () => {
  it("returns typed answer", async () => {
    const { io, write } = fakeIO();
    const p = ask(io, "Port?", "3001");
    write("4000\n");
    expect(await p).toBe("4000");
  });

  it("returns default on empty input", async () => {
    const { io, write } = fakeIO();
    const p = ask(io, "Port?", "3001");
    write("\n");
    expect(await p).toBe("3001");
  });
});

describe("select", () => {
  const choices = [
    { value: "docker", label: "Docker on this machine" },
    { value: "fly", label: "Fly.io" },
  ] as const;

  it("accepts a number", async () => {
    const { io, write } = fakeIO();
    const p = select(io, "Target?", [...choices], "docker");
    write("2\n");
    expect(await p).toBe("fly");
  });

  it("accepts the value itself", async () => {
    const { io, write } = fakeIO();
    const p = select(io, "Target?", [...choices], "docker");
    write("fly\n");
    expect(await p).toBe("fly");
  });

  it("returns default on empty input and re-asks on garbage", async () => {
    const { io, write, read } = fakeIO();
    const p1 = select(io, "Target?", [...choices], "docker");
    write("nonsense\n");
    write("\n");
    expect(await p1).toBe("docker");
    expect(read()).toContain("Please answer 1-2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/cli`
Expected: FAIL — cannot resolve `../src/prompts.js`

- [ ] **Step 3: Implement**

`packages/cli/src/prompts.ts`:

```ts
import { createInterface } from "node:readline/promises";
import type { IO } from "./main.js";

export async function ask(io: IO, question: string, def?: string): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const suffix = def !== undefined ? ` [${def}]` : "";
    const answer = (await rl.question(`${question}${suffix} `)).trim();
    return answer !== "" ? answer : (def ?? "");
  } finally {
    rl.close();
  }
}

export async function select<T extends string>(
  io: IO,
  question: string,
  choices: { value: T; label: string }[],
  def: T,
): Promise<T> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    io.output.write(`${question}\n`);
    choices.forEach((c, i) => {
      const marker = c.value === def ? "*" : " ";
      io.output.write(`  ${i + 1})${marker}${c.label} (${c.value})\n`);
    });
    for (;;) {
      const raw = (await rl.question(`> [${def}] `)).trim();
      if (raw === "") return def;
      const byNumber = choices[Number(raw) - 1];
      if (byNumber) return byNumber.value;
      const byValue = choices.find((c) => c.value === raw);
      if (byValue) return byValue.value;
      io.output.write(`Please answer 1-${choices.length} or a listed value.\n`);
    }
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/cli`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/prompts.ts packages/cli/test/prompts.test.ts
git commit -m "feat(cli): readline prompt primitives with injectable IO"
```

---

### Task 3: The interview (flags + question tree → `Answers`)

**Files:**
- Create: `packages/cli/src/questions.ts`
- Test: `packages/cli/test/questions.test.ts`

**Interfaces:**
- Consumes: `ask`/`select` from Task 2, `IO` from Task 1
- Produces:

```ts
export interface Answers {
  mode: "instance" | "player" | "both";
  target: "docker" | "fly" | "railway" | "existing" | null; // null when mode === "player" with --url
  storage: "local" | "s3" | null;
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string; region: string } | null;
  port: number;
  volume: string;
  url: string | null;       // existing instance URL
  signup: { email: string; password: string } | null;
  dryRun: boolean;
}
export function parseFlags(argv: string[]): Flags;             // util.parseArgs wrapper
export function detectContext(cwd: string): "web-project" | "empty"; // package.json present?
export async function collectAnswers(flags: Flags, io: IO, context: "web-project" | "empty"): Promise<Answers>;
```

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/questions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags, detectContext, collectAnswers } from "../src/questions.js";
import { fakeIO } from "./main.test.js";

describe("parseFlags", () => {
  it("parses all long flags", () => {
    const f = parseFlags([
      "--mode", "instance", "--target", "docker", "--storage", "s3",
      "--port", "4000", "--volume", "bandstuff",
      "--s3-endpoint", "https://x.r2.cloudflarestorage.com",
      "--s3-bucket", "demos", "--s3-access-key", "AK", "--s3-secret-key", "SK",
      "--email", "dl@fldl.space", "--password", "hunter22",
      "--yes", "--dry-run",
    ]);
    expect(f.mode).toBe("instance");
    expect(f.port).toBe("4000");
    expect(f.yes).toBe(true);
    expect(f.dryRun).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(() => parseFlags(["--mode", "banana"])).toThrow(/mode/);
  });
});

describe("detectContext", () => {
  it("web-project when package.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    writeFileSync(join(dir, "package.json"), "{}");
    expect(detectContext(dir)).toBe("web-project");
  });
  it("empty otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    expect(detectContext(dir)).toBe("empty");
  });
});

describe("collectAnswers", () => {
  it("fully non-interactive with flags + --yes (docker/local)", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--storage", "local", "--yes"]);
    const a = await collectAnswers(flags, io, "empty");
    expect(a).toMatchObject({
      mode: "instance", target: "docker", storage: "local",
      port: 3001, volume: "demolocker", s3: null, signup: null, url: null,
    });
  });

  it("player mode with --url skips instance questions", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "player", "--url", "https://demos.fldl.space", "--yes"]);
    const a = await collectAnswers(flags, io, "web-project");
    expect(a.target).toBeNull();
    expect(a.storage).toBeNull();
    expect(a.url).toBe("https://demos.fldl.space");
  });

  it("defaults mode by context: web-project → both, empty → instance", async () => {
    const { io } = fakeIO();
    const a1 = await collectAnswers(parseFlags(["--yes", "--target", "docker"]), io, "web-project");
    expect(a1.mode).toBe("both");
    const a2 = await collectAnswers(parseFlags(["--yes"]), io, "empty");
    expect(a2.mode).toBe("instance");
  });

  it("s3 storage requires the s3 flags in --yes mode", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--storage", "s3", "--yes"]);
    await expect(collectAnswers(flags, io, "empty")).rejects.toThrow(/--s3-endpoint/);
  });

  it("interactive path walks the tree", async () => {
    const { io, write } = fakeIO();
    const flags = parseFlags([]);
    const p = collectAnswers(flags, io, "empty");
    write("1\n");  // mode: instance
    write("1\n");  // target: docker
    write("1\n");  // storage: local
    write("\n");   // port: default 3001
    write("\n");   // volume: default demolocker
    write("\n");   // email: empty → skip signup
    const a = await p;
    expect(a.mode).toBe("instance");
    expect(a.signup).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/cli`
Expected: FAIL — cannot resolve `../src/questions.js`

- [ ] **Step 3: Implement**

`packages/cli/src/questions.ts`:

```ts
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "./main.js";
import { ask, select } from "./prompts.js";

const MODES = ["instance", "player", "both"] as const;
const TARGETS = ["docker", "fly", "railway", "existing"] as const;
const STORAGES = ["local", "s3"] as const;

export interface Flags {
  mode?: (typeof MODES)[number];
  target?: (typeof TARGETS)[number];
  storage?: (typeof STORAGES)[number];
  port?: string;
  volume?: string;
  url?: string;
  email?: string;
  password?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Region?: string;
  yes: boolean;
  dryRun: boolean;
}

export interface Answers {
  mode: (typeof MODES)[number];
  target: (typeof TARGETS)[number] | null;
  storage: (typeof STORAGES)[number] | null;
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string; region: string } | null;
  port: number;
  volume: string;
  url: string | null;
  signup: { email: string; password: string } | null;
  dryRun: boolean;
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

export function parseFlags(argv: string[]): Flags {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
      target: { type: "string" },
      storage: { type: "string" },
      port: { type: "string" },
      volume: { type: "string" },
      url: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      "s3-endpoint": { type: "string" },
      "s3-bucket": { type: "string" },
      "s3-access-key": { type: "string" },
      "s3-secret-key": { type: "string" },
      "s3-region": { type: "string" },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  return {
    mode: oneOf("mode", v.mode, MODES),
    target: oneOf("target", v.target, TARGETS),
    storage: oneOf("storage", v.storage, STORAGES),
    port: v.port,
    volume: v.volume,
    url: v.url,
    email: v.email,
    password: v.password,
    s3Endpoint: v["s3-endpoint"],
    s3Bucket: v["s3-bucket"],
    s3AccessKey: v["s3-access-key"],
    s3SecretKey: v["s3-secret-key"],
    s3Region: v["s3-region"],
    yes: v.yes ?? false,
    dryRun: v["dry-run"] ?? false,
  };
}

export function detectContext(cwd: string): "web-project" | "empty" {
  return existsSync(join(cwd, "package.json")) ? "web-project" : "empty";
}

/** Answer a question from a flag, or the default (--yes), or by prompting. */
async function resolve<T extends string>(
  flagValue: T | undefined,
  yes: boolean,
  promptFn: () => Promise<T>,
  def: T,
): Promise<T> {
  if (flagValue !== undefined) return flagValue;
  if (yes) return def;
  return promptFn();
}

export async function collectAnswers(
  flags: Flags,
  io: IO,
  context: "web-project" | "empty",
): Promise<Answers> {
  const defaultMode = context === "web-project" ? "both" : "instance";
  const mode = await resolve(flags.mode, flags.yes, () =>
    select(io, "What do you need?", [
      { value: "instance", label: "A Demo Locker — editable playlists your band can comment on" },
      { value: "player", label: "A public-facing player added to this project" },
      { value: "both", label: "Both — the locker plus an embedded public player" },
    ], defaultMode), defaultMode);

  const needsInstance = mode !== "player" || flags.url === undefined;
  const playerOnly = mode === "player";

  let target: Answers["target"] = null;
  let storage: Answers["storage"] = null;
  let s3: Answers["s3"] = null;
  let url: string | null = flags.url ?? null;
  let port = Number(flags.port ?? 3001);
  let volume = flags.volume ?? "demolocker";
  let signup: Answers["signup"] = null;

  if (playerOnly && url) {
    // Pointing the player at an existing instance — nothing to deploy.
    return { mode, target: null, storage: null, s3: null, port, volume, url, signup: null, dryRun: flags.dryRun };
  }

  if (needsInstance) {
    target = await resolve(flags.target, flags.yes, () =>
      select(io, "Where will it run?", [
        { value: "docker", label: "Docker on this machine (laptop, Pi, VPS — wherever you're running this)" },
        { value: "fly", label: "Fly.io (managed hosting, free-ish tier, needs flyctl)" },
        { value: "railway", label: "Railway (guided instructions)" },
        { value: "existing", label: "I already have an instance running" },
      ], "docker"), "docker");

    if (target === "existing") {
      url = flags.url ?? (flags.yes ? null : await ask(io, "Instance URL (e.g. https://demos.example.com)?"));
      if (!url) throw new Error("--url is required for --target existing");
      return { mode, target, storage: null, s3: null, port, volume, url, signup: null, dryRun: flags.dryRun };
    }

    storage = await resolve(flags.storage, flags.yes, () =>
      select(io, "Where should audio files live?", [
        { value: "local", label: "Local disk (inside the data volume — simplest, back up one folder)" },
        { value: "s3", label: "S3-compatible bucket (R2, B2, MinIO, AWS)" },
      ], "local"), "local");

    if (storage === "s3") {
      const need = async (flag: string | undefined, name: string, q: string, def?: string) => {
        if (flag !== undefined) return flag;
        if (flags.yes) {
          if (def !== undefined) return def;
          throw new Error(`--storage s3 with --yes requires --${name}`);
        }
        return ask(io, q, def);
      };
      s3 = {
        endpoint: await need(flags.s3Endpoint, "s3-endpoint", "S3 endpoint URL?"),
        accessKey: await need(flags.s3AccessKey, "s3-access-key", "S3 access key?"),
        secretKey: await need(flags.s3SecretKey, "s3-secret-key", "S3 secret key?"),
        bucket: await need(flags.s3Bucket, "s3-bucket", "Bucket name?", "demos"),
        region: await need(flags.s3Region, "s3-region", "Region?", "auto"),
      };
    }

    if (target === "docker") {
      port = Number(flags.port ?? (flags.yes ? "3001" : await ask(io, "Host port?", "3001")));
      volume = flags.volume ?? (flags.yes ? "demolocker" : await ask(io, "Docker volume name (your music lives here)?", "demolocker"));
    }

    if (flags.email && flags.password) {
      signup = { email: flags.email, password: flags.password };
    } else if (!flags.yes) {
      const email = await ask(io, "Create the first account now? Email (empty to skip):", "");
      if (email) signup = { email, password: await ask(io, "Password?") };
    }
  }

  return { mode, target, storage, s3, port, volume, url, signup, dryRun: flags.dryRun };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/cli`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/questions.ts packages/cli/test/questions.test.ts
git commit -m "feat(cli): interview — flags, context detection, question tree"
```

---

### Task 4: Plan generator (`Answers` → `DeployPlan`)

**Files:**
- Create: `packages/cli/src/plan.ts`
- Test: `packages/cli/test/plan.test.ts`

**Interfaces:**
- Consumes: `Answers` from Task 3
- Produces:

```ts
export type Step =
  | { kind: "run"; title: string; cmd: string; args: string[] }
  | { kind: "write"; title: string; path: string; contents: string }
  | { kind: "note"; text: string };
export interface DeployPlan {
  steps: Step[];
  healthUrl: string | null;  // poll after steps complete
  appUrl: string | null;     // print to the user / feed the player snippet
}
export function buildPlan(a: Answers): DeployPlan;
export function renderPlan(p: DeployPlan): string;  // human-readable, used by --dry-run
```

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPlan, renderPlan } from "../src/plan.js";
import type { Answers } from "../src/questions.js";

const base: Answers = {
  mode: "instance", target: "docker", storage: "local", s3: null,
  port: 3001, volume: "demolocker", url: null, signup: null, dryRun: false,
};

describe("buildPlan docker", () => {
  it("local storage: volume create + docker run", () => {
    const p = buildPlan(base);
    const runs = p.steps.filter((s) => s.kind === "run");
    expect(runs[0]).toMatchObject({ cmd: "docker", args: ["volume", "create", "demolocker"] });
    expect(runs[1].args).toEqual([
      "run", "-d", "--name", "demolocker", "--restart", "unless-stopped",
      "-v", "demolocker:/data", "-p", "3001:3001",
      "ghcr.io/usedrobot/demo-locker:latest",
    ]);
    expect(p.healthUrl).toBe("http://localhost:3001/health");
    expect(p.appUrl).toBe("http://localhost:3001");
  });

  it("s3 storage injects -e env flags", () => {
    const p = buildPlan({
      ...base, storage: "s3",
      s3: { endpoint: "http://minio:9000", accessKey: "AK", secretKey: "SK", bucket: "demos", region: "auto" },
    });
    const run = p.steps.find((s) => s.kind === "run" && s.args[0] === "run")!;
    expect(run.args).toContain("S3_ENDPOINT=http://minio:9000");
    expect(run.args).toContain("S3_SECRET_KEY=SK");
  });

  it("custom port maps host:3001", () => {
    const p = buildPlan({ ...base, port: 8080 });
    const run = p.steps.find((s) => s.kind === "run" && s.args[0] === "run")!;
    expect(run.args).toContain("8080:3001");
    expect(p.appUrl).toBe("http://localhost:8080");
  });
});

describe("buildPlan fly", () => {
  it("writes fly.toml then launch/volume/deploy", () => {
    const p = buildPlan({ ...base, target: "fly" });
    expect(p.steps[0]).toMatchObject({ kind: "write", path: "fly.toml" });
    const cmds = p.steps.filter((s) => s.kind === "run").map((s) => s.args.join(" "));
    expect(cmds).toEqual([
      "launch --copy-config --no-deploy",
      "volumes create data --size 3",
      "deploy",
    ]);
    expect(p.healthUrl).toBeNull(); // app name chosen by fly launch; verify step prints instructions
  });
});

describe("buildPlan railway / existing", () => {
  it("railway emits notes only", () => {
    const p = buildPlan({ ...base, target: "railway" });
    expect(p.steps.every((s) => s.kind === "note")).toBe(true);
  });
  it("existing instance emits no steps, appUrl passthrough", () => {
    const p = buildPlan({ ...base, target: "existing", url: "https://demos.fldl.space" });
    expect(p.steps).toHaveLength(0);
    expect(p.appUrl).toBe("https://demos.fldl.space");
    expect(p.healthUrl).toBe("https://demos.fldl.space/health");
  });
});

describe("renderPlan", () => {
  it("prints each step on its own line", () => {
    const text = renderPlan(buildPlan(base));
    expect(text).toContain("docker volume create demolocker");
    expect(text).toContain("docker run -d");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/cli`
Expected: FAIL — cannot resolve `../src/plan.js`

- [ ] **Step 3: Implement**

`packages/cli/src/plan.ts`:

```ts
import type { Answers } from "./questions.js";

export const IMAGE = "ghcr.io/usedrobot/demo-locker:latest";

export type Step =
  | { kind: "run"; title: string; cmd: string; args: string[] }
  | { kind: "write"; title: string; path: string; contents: string }
  | { kind: "note"; text: string };

export interface DeployPlan {
  steps: Step[];
  healthUrl: string | null;
  appUrl: string | null;
}

const FLY_TOML = `# Fly.io deploy for the Demo Locker standalone image.
app = "demo-locker"
primary_region = "mia"

[build]
  image = "${IMAGE}"

[mounts]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
`;

export function buildPlan(a: Answers): DeployPlan {
  switch (a.target) {
    case "docker": {
      const envArgs: string[] = [];
      if (a.s3) {
        const e = a.s3;
        for (const [k, v] of [
          ["S3_ENDPOINT", e.endpoint], ["S3_ACCESS_KEY", e.accessKey],
          ["S3_SECRET_KEY", e.secretKey], ["S3_BUCKET", e.bucket], ["S3_REGION", e.region],
        ]) envArgs.push("-e", `${k}=${v}`);
      }
      const appUrl = `http://localhost:${a.port}`;
      return {
        steps: [
          { kind: "run", title: "Create data volume", cmd: "docker", args: ["volume", "create", a.volume] },
          {
            kind: "run", title: "Start Demo Locker", cmd: "docker",
            args: [
              "run", "-d", "--name", a.volume, "--restart", "unless-stopped",
              "-v", `${a.volume}:/data`, "-p", `${a.port}:3001`, ...envArgs, IMAGE,
            ],
          },
        ],
        healthUrl: `${appUrl}/health`,
        appUrl,
      };
    }
    case "fly":
      return {
        steps: [
          { kind: "write", title: "Write fly.toml", path: "fly.toml", contents: FLY_TOML },
          { kind: "run", title: "Create fly app", cmd: "fly", args: ["launch", "--copy-config", "--no-deploy"] },
          { kind: "run", title: "Create data volume", cmd: "fly", args: ["volumes", "create", "data", "--size", "3"] },
          { kind: "run", title: "Deploy", cmd: "fly", args: ["deploy"] },
        ],
        healthUrl: null,
        appUrl: null,
      };
    case "railway":
      return {
        steps: [
          { kind: "note", text: "Railway can't be driven headlessly from here. In the Railway dashboard:" },
          { kind: "note", text: `1. New Project → Deploy a Docker image → ${IMAGE}` },
          { kind: "note", text: "2. Add a volume mounted at /data" },
          { kind: "note", text: "3. Settings → Networking → expose port 3001" },
          { kind: "note", text: "4. Open the generated URL and sign up — first account in wins." },
        ],
        healthUrl: null,
        appUrl: null,
      };
    case "existing":
      return {
        steps: [],
        healthUrl: a.url ? `${a.url.replace(/\/$/, "")}/health` : null,
        appUrl: a.url,
      };
    default:
      return { steps: [], healthUrl: null, appUrl: a.url };
  }
}

export function renderPlan(p: DeployPlan): string {
  const lines = p.steps.map((s) => {
    if (s.kind === "run") return `$ ${s.cmd} ${s.args.join(" ")}`;
    if (s.kind === "write") return `write ${s.path}`;
    return `# ${s.text}`;
  });
  if (p.healthUrl) lines.push(`then wait for ${p.healthUrl}`);
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/cli`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/plan.ts packages/cli/test/plan.test.ts
git commit -m "feat(cli): pure deploy-plan generator for docker/fly/railway/existing"
```

---

### Task 5: Executor (run the plan, wait for health, create first account)

**Files:**
- Create: `packages/cli/src/execute.ts`
- Test: `packages/cli/test/execute.test.ts`

**Interfaces:**
- Consumes: `DeployPlan`/`Step` from Task 4, `IO` from Task 1, `Answers.signup`
- Produces:

```ts
export interface Runner {
  exec(cmd: string, args: string[]): Promise<number>;             // spawn, inherit stdio; resolves exit code
  writeFile(path: string, contents: string): Promise<void>;
  fetchFn: typeof fetch;
  sleep(ms: number): Promise<void>;
}
export function defaultRunner(io: IO): Runner;
export async function executePlan(plan: DeployPlan, signup: {email: string; password: string} | null, io: IO, runner: Runner): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/execute.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { executePlan } from "../src/execute.js";
import type { Runner } from "../src/execute.js";
import type { DeployPlan } from "../src/plan.js";
import { fakeIO } from "./main.test.js";

function fakeRunner(overrides: Partial<Runner> = {}): Runner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: vi.fn(async (cmd, args) => { calls.push(`${cmd} ${args.join(" ")}`); return 0; }),
    writeFile: vi.fn(async (path) => { calls.push(`write ${path}`); }),
    fetchFn: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    sleep: async () => {},
    ...overrides,
  };
}

const dockerPlan: DeployPlan = {
  steps: [
    { kind: "run", title: "Create data volume", cmd: "docker", args: ["volume", "create", "demolocker"] },
    { kind: "run", title: "Start", cmd: "docker", args: ["run", "-d"] },
  ],
  healthUrl: "http://localhost:3001/health",
  appUrl: "http://localhost:3001",
};

describe("executePlan", () => {
  it("runs steps in order, polls health, prints URL", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner();
    const code = await executePlan(dockerPlan, null, io, r);
    expect(code).toBe(0);
    expect(r.calls).toEqual(["docker volume create demolocker", "docker run -d"]);
    expect(read()).toContain("http://localhost:3001");
  });

  it("stops on nonzero exit and reports the failed step", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({ exec: vi.fn(async () => 1) });
    const code = await executePlan(dockerPlan, null, io, r);
    expect(code).toBe(1);
    expect(read()).toContain("failed");
  });

  it("creates the first account when signup is given", async () => {
    const { io, read } = fakeIO();
    const fetchFn = vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith("/auth/signup")) {
        expect(JSON.parse(init.body)).toEqual({ email: "dl@fldl.space", password: "pw" });
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = fakeRunner({ fetchFn });
    const code = await executePlan(dockerPlan, { email: "dl@fldl.space", password: "pw" }, io, r);
    expect(code).toBe(0);
    expect(read()).toContain("Account created");
  });

  it("gives up on health after 60 attempts", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({ fetchFn: vi.fn(async () => { throw new Error("conn refused"); }) as unknown as typeof fetch });
    const code = await executePlan(dockerPlan, null, io, r);
    expect(code).toBe(1);
    expect(read()).toContain("never became healthy");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/cli`
Expected: FAIL — cannot resolve `../src/execute.js`

- [ ] **Step 3: Implement**

`packages/cli/src/execute.ts`:

```ts
import { spawn } from "node:child_process";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { IO } from "./main.js";
import type { DeployPlan } from "./plan.js";

export interface Runner {
  exec(cmd: string, args: string[]): Promise<number>;
  writeFile(path: string, contents: string): Promise<void>;
  fetchFn: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export function defaultRunner(_io: IO): Runner {
  return {
    exec: (cmd, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: "inherit" });
        child.on("error", (err) =>
          reject(new Error(`could not run "${cmd}" — is it installed and on PATH? (${err.message})`)),
        );
        child.on("close", (code) => resolve(code ?? 1));
      }),
    writeFile: (path, contents) => fsWriteFile(path, contents),
    fetchFn: fetch,
    sleep: (ms) => delay(ms),
  };
}

async function waitHealthy(url: string, runner: Runner): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await runner.fetchFn(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await runner.sleep(1000);
  }
  return false;
}

export async function executePlan(
  plan: DeployPlan,
  signup: { email: string; password: string } | null,
  io: IO,
  runner: Runner,
): Promise<number> {
  for (const step of plan.steps) {
    if (step.kind === "note") {
      io.output.write(`${step.text}\n`);
      continue;
    }
    io.output.write(`→ ${step.title}\n`);
    if (step.kind === "write") {
      await runner.writeFile(step.path, step.contents);
      continue;
    }
    const code = await runner.exec(step.cmd, step.args);
    if (code !== 0) {
      io.output.write(`✗ step failed (${step.cmd} exited ${code}): ${step.title}\n`);
      return 1;
    }
  }

  if (plan.healthUrl) {
    io.output.write(`→ waiting for ${plan.healthUrl}\n`);
    if (!(await waitHealthy(plan.healthUrl, runner))) {
      io.output.write(`✗ server never became healthy at ${plan.healthUrl}\n`);
      if (plan.appUrl?.includes("localhost")) io.output.write(`  check: docker logs\n`);
      return 1;
    }
    io.output.write(`✓ healthy\n`);
  }

  if (signup && plan.appUrl) {
    const res = await runner.fetchFn(`${plan.appUrl.replace(/\/$/, "")}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signup),
    });
    if (res.ok) io.output.write(`✓ Account created for ${signup.email}\n`);
    else io.output.write(`✗ signup failed (${res.status}) — open the app and sign up manually\n`);
  }

  if (plan.appUrl) {
    io.output.write(`\nYour Demo Locker: ${plan.appUrl}\n`);
    if (!signup) io.output.write(`Open it and sign up — the first account in wins.\n`);
  }
  return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/cli`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/execute.ts packages/cli/test/execute.test.ts
git commit -m "feat(cli): plan executor with health wait and first-account signup"
```

---

### Task 6: Player mode (install `@demo-locker/player`, emit the embed snippet)

**Files:**
- Create: `packages/cli/src/embed.ts`
- Test: `packages/cli/test/embed.test.ts`

**Interfaces:**
- Consumes: `Runner` from Task 5, `IO` from Task 1
- Produces:

```ts
export function embedSnippets(instanceUrl: string): { scriptTag: string; npmModule: string };
export async function setupPlayer(instanceUrl: string, cwd: string, io: IO, runner: Runner): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/embed.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedSnippets, setupPlayer } from "../src/embed.js";
import { fakeIO } from "./main.test.js";

describe("embedSnippets", () => {
  it("script tag loads embed.js from the instance, no instance attr needed", () => {
    const s = embedSnippets("https://demos.fldl.space");
    expect(s.scriptTag).toContain('<script src="https://demos.fldl.space/embed.js"></script>');
    expect(s.scriptTag).toContain('<demo-locker-player playlist="YOUR_PLAYLIST_ID">');
  });
  it("npm variant includes the required instance attribute", () => {
    const s = embedSnippets("https://demos.fldl.space");
    expect(s.npmModule).toContain('import "@demo-locker/player"');
    expect(s.npmModule).toContain('instance="https://demos.fldl.space"');
  });
});

describe("setupPlayer", () => {
  it("in a web project: npm-installs the player and prints the module snippet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-"));
    writeFileSync(join(dir, "package.json"), "{}");
    const { io, read } = fakeIO();
    const exec = vi.fn(async () => 0);
    const code = await setupPlayer("https://demos.fldl.space", dir, io, {
      exec, writeFile: async () => {}, fetchFn: fetch, sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledWith("npm", ["install", "@demo-locker/player"]);
    expect(read()).toContain('import "@demo-locker/player"');
  });

  it("outside a project: prints the script-tag snippet, installs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-"));
    const { io, read } = fakeIO();
    const exec = vi.fn(async () => 0);
    const code = await setupPlayer("https://demos.fldl.space", dir, io, {
      exec, writeFile: async () => {}, fetchFn: fetch, sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(read()).toContain("/embed.js");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w packages/cli`
Expected: FAIL — cannot resolve `../src/embed.js`

- [ ] **Step 3: Implement**

`packages/cli/src/embed.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "./main.js";
import type { Runner } from "./execute.js";

export function embedSnippets(instanceUrl: string): { scriptTag: string; npmModule: string } {
  const base = instanceUrl.replace(/\/$/, "");
  return {
    scriptTag: `<script src="${base}/embed.js"></script>
<demo-locker-player playlist="YOUR_PLAYLIST_ID"></demo-locker-player>`,
    npmModule: `import "@demo-locker/player";
// then in your markup:
// <demo-locker-player instance="${base}" playlist="YOUR_PLAYLIST_ID"></demo-locker-player>`,
  };
}

export async function setupPlayer(
  instanceUrl: string,
  cwd: string,
  io: IO,
  runner: Runner,
): Promise<number> {
  const snippets = embedSnippets(instanceUrl);
  const inProject = existsSync(join(cwd, "package.json"));

  if (inProject) {
    io.output.write("→ installing @demo-locker/player\n");
    const code = await runner.exec("npm", ["install", "@demo-locker/player"]);
    if (code !== 0) {
      io.output.write("✗ npm install failed\n");
      return 1;
    }
    io.output.write(`\nAdd the player to your app:\n\n${snippets.npmModule}\n`);
  } else {
    io.output.write(`\nDrop this into any HTML page:\n\n${snippets.scriptTag}\n`);
  }
  io.output.write(
    "\nOnly playlists marked public are embeddable — toggle that in the Demo Locker UI,\nthen replace YOUR_PLAYLIST_ID with the playlist's ID.\n",
  );
  return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/cli`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/embed.ts packages/cli/test/embed.test.ts
git commit -m "feat(cli): player mode — install @demo-locker/player and emit embed snippets"
```

---

### Task 7: Wire it all in `main()` + end-to-end verification

**Files:**
- Modify: `packages/cli/src/main.ts` (replace the stub body)
- Test: `packages/cli/test/main.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 2-6
- Produces: the finished `main(argv, io, deps?)`. Optional `deps` parameter `{ runner?: Runner; cwd?: string }` for tests.

- [ ] **Step 1: Extend the tests**

Append to `packages/cli/test/main.test.ts`:

```ts
import { vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("main end-to-end (non-interactive)", () => {
  it("--dry-run prints the docker plan without executing", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const code = await main(
      ["--mode", "instance", "--target", "docker", "--storage", "local", "--yes", "--dry-run"],
      io,
      { runner: { exec, writeFile: async () => {}, fetchFn: fetch, sleep: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(read()).toContain("docker run -d");
    expect(exec).not.toHaveBeenCalled();
  });

  it("full instance run executes plan and prints URL", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const code = await main(
      ["--mode", "instance", "--target", "docker", "--yes"],
      io,
      { runner: { exec, writeFile: async () => {}, fetchFn, sleep: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2); // volume create + docker run
    expect(read()).toContain("Your Demo Locker: http://localhost:3001");
  });

  it("player mode with --url skips deploy, emits snippet", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const code = await main(
      ["--mode", "player", "--url", "https://demos.fldl.space", "--yes"],
      io,
      { runner: { exec, writeFile: async () => {}, fetchFn: fetch, sleep: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(read()).toContain("https://demos.fldl.space/embed.js");
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test -w packages/cli`
Expected: FAIL — main ignores flags, prints usage

- [ ] **Step 3: Implement the full main**

Replace the body of `packages/cli/src/main.ts` below the `USAGE` constant (keep `IO`, `USAGE`, and the help/version handling from Task 1):

```ts
import { createRequire } from "node:module";
import { parseFlags, detectContext, collectAnswers } from "./questions.js";
import { buildPlan, renderPlan } from "./plan.js";
import { executePlan, defaultRunner } from "./execute.js";
import type { Runner } from "./execute.js";
import { setupPlayer } from "./embed.js";

export interface IO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export async function main(
  argv: string[],
  io: IO,
  deps: { runner?: Runner; cwd?: string } = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.output.write(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    const require = createRequire(import.meta.url);
    io.output.write(require("../package.json").version + "\n");
    return 0;
  }

  const cwd = deps.cwd ?? process.cwd();
  const runner = deps.runner ?? defaultRunner(io);

  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    io.output.write(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    return 1;
  }

  const answers = await collectAnswers(flags, io, detectContext(cwd));
  const wantsInstance = answers.mode === "instance" || answers.mode === "both";
  const wantsPlayer = answers.mode === "player" || answers.mode === "both";

  let instanceUrl = answers.url;

  if (wantsInstance || (wantsPlayer && answers.target)) {
    const plan = buildPlan(answers);
    if (answers.dryRun) {
      io.output.write(renderPlan(plan));
      return 0;
    }
    const code = await executePlan(plan, answers.signup, io, runner);
    if (code !== 0) return code;
    instanceUrl = plan.appUrl ?? instanceUrl;
  }

  if (wantsPlayer) {
    if (!instanceUrl) {
      io.output.write("No instance URL known — pass --url or deploy an instance first.\n");
      return 1;
    }
    return setupPlayer(instanceUrl, cwd, io, runner);
  }
  return 0;
}
```

(The `USAGE` string stays as written in Task 1.)

- [ ] **Step 4: Run all tests**

Run: `npm test -w packages/cli && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: Real-world verification (requires Docker running)**

```bash
npm run build -w packages/cli
cd "$(mktemp -d)"
node /Users/davidtashjian/webdev/demolocker/packages/cli/dist/cli.js \
  --mode instance --target docker --storage local \
  --port 3499 --volume dl-wizard-test --yes
curl -fsS http://localhost:3499/health
# expected: {"ok":true} (or the health payload) and "Your Demo Locker: http://localhost:3499" printed above
# cleanup:
docker rm -f dl-wizard-test && docker volume rm dl-wizard-test
```

Also run it once with no flags in an empty temp dir and answer the prompts interactively — the wizard must feel right, not just pass tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/test/main.test.ts
git commit -m "feat(cli): wire interview → plan → execute → player into main"
```

---

### Task 8: Docs + publish pipeline

**Files:**
- Create: `packages/cli/README.md`
- Create: `.github/workflows/publish-cli.yml`
- Modify: `README.md` (root — add the npx quick start)
- Modify: `docs/host-your-music.md` (add npx as the first path)
- Modify: `AGENTS.md` (add the non-interactive invocation for agents)

**Interfaces:**
- Consumes: the finished CLI from Task 7 and the flag surface from Task 3

- [ ] **Step 1: Write `packages/cli/README.md`**

```markdown
# demo-locker

Setup wizard for [Demo Locker](https://github.com/usedrobot/demo-locker) —
self-hosted music streaming for demos and mixes your band can comment on,
with timestamps.

## Use

​```bash
npx demo-locker
​```

Answers a few questions (what do you need, where's it running, where do the
tracks live) and spins it up: Docker on the machine you're on (laptop, Pi,
VPS), Fly.io, or guided setup for Railway. Can also wire the embeddable
public player (`@demo-locker/player`) into an existing web project.

## Non-interactive (for scripts and agents)

Every question has a flag; `--yes` accepts defaults:

​```bash
npx demo-locker --mode instance --target docker --storage local \
  --port 3001 --volume demolocker --email you@example.com --password ... --yes
​```

`--dry-run` prints the deploy plan without running anything.

## Requirements

Node 20+, and Docker for the docker target (flyctl for fly).
```

(Remove the zero-width escapes around the code fences — they're only here so this plan renders.)

- [ ] **Step 2: Create `.github/workflows/publish-cli.yml`**

Copy `publish-player.yml` exactly, with these substitutions: trigger `tags: ["cli-v*"]`, name `Publish cli`, every `-w packages/player` → `-w packages/cli`, tag prefix check `${GITHUB_REF_NAME#cli-v}`, package path `./packages/cli/package.json`, and the artifact check becomes:

```yaml
      - name: Verify build artifacts
        run: |
          if [ ! -s "packages/cli/dist/cli.js" ]; then
            echo "missing or empty dist/cli.js" >&2
            exit 1
          fi
          head -1 packages/cli/dist/cli.js | grep -q '^#!/usr/bin/env node' || {
            echo "dist/cli.js missing shebang" >&2; exit 1;
          }
```

Keep the SHA-pinned action versions, `npm ci`, node 24, and the OIDC/provenance comments verbatim — including the header comment block explaining the manual first publish (adapted for `demo-locker` instead of `@demo-locker/player`).

- [ ] **Step 3: Doc pointers**

Root `README.md`: in the quick-start area, add before the docker instructions:

```markdown
## Fastest start

​```bash
npx demo-locker
​```

The wizard asks where you want it running and takes it from there. Manual paths below.
```

`docs/host-your-music.md`: same one-liner added at the top as the recommended path, existing `docker run` content stays as the manual path.

`AGENTS.md`: in the deploy runbook section, add:

```markdown
## Scripted setup (preferred)

The wizard drives the whole deploy non-interactively:

​```bash
npx demo-locker --mode instance --target docker --storage local --yes \
  --email USER_EMAIL --password USER_PASSWORD
​```

Interview the human first: what hardware is on hand (old laptop / Pi / VPS / PaaS)?
public listening or band-and-friends? Then map their answers onto the flags above
(`--target fly` for PaaS; `--storage s3 --s3-endpoint ...` when they already have a bucket).
```

- [ ] **Step 4: Verify docs render and CI is green locally**

Run: `npm run typecheck && npm run lint && npm test -w packages/cli && npm run build -w packages/cli`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/README.md .github/workflows/publish-cli.yml README.md docs/host-your-music.md AGENTS.md
git commit -m "docs(cli): README, publish pipeline, npx quick start across docs"
```

---

### Task 9: Release checklist (manual — DL in the loop)

Not code. After the PR merges and CI is green:

- [ ] **Step 1: First manual publish** (npm can't OIDC-publish a new package — npm/cli#8544; DL's npm 2FA is passkey-based so this needs an interactive terminal):

```bash
cd ~/webdev/demolocker
npm login
npm run build -w packages/cli
npm publish --access public --provenance=false -w packages/cli
npm logout
```

- [ ] **Step 2: Configure trusted publishing** on npmjs.com → package `demo-locker` → Settings → Trusted publishing: GitHub Actions / org `usedrobot` / repository `demo-locker` / workflow `publish-cli.yml` / environment blank / allowed actions "npm publish".

- [ ] **Step 3: Smoke the published package** on a clean machine/dir: `npx demo-locker@latest --dry-run --mode instance --target docker --yes` then a real run.

- [ ] **Step 4: Do NOT tag `cli-v0.1.0`** (the manually published version) — the workflow would try to republish and fail. The first tagged release is `cli-v0.1.1`+.

---

## Self-review notes

- **Spec coverage:** Q1 what-do-you-need → Task 3 mode question (context-aware defaults per DL: empty dir → instance, web project → both). Q2 hosting → Task 3 target + Task 4 docker/fly/railway plans. Q3 where-tracks-live → Task 3 storage + s3 sub-questions, Task 4 env injection. Q4 config vars → port/volume/signup flags + prompts. Q5 spin-up-and-verify → Task 5 executor with health poll + signup + printed URL; player wiring → Task 6. Agent-driveable → non-interactive flags throughout + AGENTS.md section in Task 8.
- **Deliberate scope cuts (v1):** no compose-file generation (single container + volume covers docker); railway is instructions-only; no `install.sh` Node bootstrap (per roadmap: only if agent-QA shows demand); no update/uninstall subcommands (docs cover `docker pull` + restart — the standalone image migrates PGlite on boot).
- **Known risk:** root package rename (`demo-locker` → `demo-locker-monorepo`) — grep CI and scripts for anything keying on the root package name before merging Task 1.
