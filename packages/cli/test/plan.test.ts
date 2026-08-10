import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan, renderPlan, ASSETS_DIR } from "../src/plan.js";
import type { Answers } from "../src/questions.js";

const base: Answers = {
  mode: "instance", target: "docker", storage: "local", s3: null, cloudflare: null,
  port: 3001, volume: "demolocker", url: null, signup: null, dryRun: false,
};

describe("buildPlan docker", () => {
  it("local storage: volume create + docker run", () => {
    const p = buildPlan(base);
    const runs = p.steps.filter((s): s is Extract<typeof p.steps[number], {kind:"run"}> => s.kind === "run");
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
    const run = p.steps.find((s): s is Extract<typeof p.steps[number], {kind:"run"}> => s.kind === "run" && s.args[0] === "run")!;
    expect(run.args).toContain("S3_ENDPOINT=http://minio:9000");
    expect(run.args).toContain("S3_SECRET_KEY=SK");
  });

  it("custom port maps host:3001", () => {
    const p = buildPlan({ ...base, port: 8080 });
    const run = p.steps.find((s): s is Extract<typeof p.steps[number], {kind:"run"}> => s.kind === "run" && s.args[0] === "run")!;
    expect(run.args).toContain("8080:3001");
    expect(p.appUrl).toBe("http://localhost:8080");
  });
});

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

describe("buildPlan existing", () => {
  it("existing instance emits no steps, appUrl passthrough", () => {
    const p = buildPlan({ ...base, target: "existing", url: "https://demos.fldl.space" });
    expect(p.steps).toHaveLength(0);
    expect(p.appUrl).toBe("https://demos.fldl.space");
    expect(p.healthUrl).toBe("https://demos.fldl.space/health");
  });
});

describe("buildPlan cloudflare target is recognized", () => {
  it("does not fall through to the empty default case", () => {
    const p = buildPlan({
      ...base, target: "cloudflare", storage: null, port: 3001,
      cloudflare: { workerName: "demo-locker", d1Name: "demo-locker-db", r2Bucket: "demo-locker-demos", domain: null },
    });
    expect(p.steps.length).toBeGreaterThan(0);
  });
});

describe("buildPlan refuses to silently do nothing", () => {
  it("throws rather than returning an empty plan when cloudflare answers are missing", () => {
    expect(() => buildPlan({ ...base, target: "cloudflare", cloudflare: null }))
      .toThrow(/cloudflare/);
  });

  it("throws when there is no target at all", () => {
    expect(() => buildPlan({ ...base, target: null })).toThrow(/no deploy target/);
  });
});

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
  it("emits copy, create, capture, write, migrate, deploy in order", () => {
    const p = buildPlan(cfBase);
    expect(p.steps.map((s) => s.kind)).toEqual([
      "copy", "note", "run", "run-capture", "run", "write", "run", "run",
    ]);
  });

  it("unpacks the packaged deployable into the same dir the config is written to", () => {
    const p = buildPlan(cfBase);
    const copy = p.steps.find((s) => s.kind === "copy")!;
    expect(copy.to).toBe(ASSETS_DIR);
    expect(copy.from).toMatch(/assets$/);
  });

  it("warns about the R2 billing requirement before provisioning anything", () => {
    const p = buildPlan(cfBase);
    const kinds = p.steps.map((s) => s.kind);
    const firstNote = kinds.indexOf("note");
    expect(firstNote).toBeGreaterThanOrEqual(0);
    expect(firstNote).toBeLessThan(kinds.indexOf("run"));
    expect((p.steps[firstNote] as { text: string }).text).toMatch(/billing/i);
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
    expect(cfg.main).toBe("worker.js");
    expect(cfg.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(cfg.d1_databases[0]).toMatchObject({
      binding: "DB", database_name: "demo-locker-db", database_id: "__DATABASE_ID__",
      migrations_dir: "migrations",
    });
    expect(cfg.r2_buckets[0]).toMatchObject({
      binding: "DEMOS_BUCKET", bucket_name: "demo-locker-demos",
    });
    expect(cfg.assets.directory).toBe("public");
    expect(cfg.assets.not_found_handling).toBe("single-page-application");
    // Both forms per prefix: `/playlists/*` does NOT match bare `/playlists`,
    // so a wildcard-only list sends every collection endpoint to the SPA index.
    expect(cfg.assets.run_worker_first).toEqual([
      "/health",
      "/auth", "/auth/*",
      "/playlists", "/playlists/*",
      "/comments", "/comments/*",
      "/shares", "/shares/*",
      "/collab", "/collab/*",
      "/tracks", "/tracks/*",
      "/public/v1", "/public/v1/*",
    ]);
    expect(cfg.routes).toBeUndefined();

    const runs = p.steps.filter((s): s is Extract<typeof p.steps[number], { kind: "run" }> => s.kind === "run");
    const migrate = runs.find((s) => s.args.includes("migrations"))!;
    const deploy = runs.find((s) => s.args.includes("deploy"))!;
    expect(migrate.args.slice(migrate.args.indexOf("--config"))).toEqual(["--config", "demo-locker/wrangler.jsonc"]);
    expect(deploy.args.slice(deploy.args.indexOf("--config"))).toEqual(["--config", "demo-locker/wrangler.jsonc"]);
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

describe("renderPlan", () => {
  it("prints each step on its own line", () => {
    const text = renderPlan(buildPlan(base));
    expect(text).toContain("docker volume create demolocker");
    expect(text).toContain("docker run -d");
  });

  it("redacts secret-like env values but keeps others readable", () => {
    const p = buildPlan({
      ...base, storage: "s3",
      s3: { endpoint: "http://minio:9000", accessKey: "AK", secretKey: "sekret-value", bucket: "demos", region: "auto" },
    });
    const text = renderPlan(p);
    expect(text).toContain("S3_SECRET_KEY=***");
    expect(text).not.toContain("sekret-value");
    expect(text).toContain("S3_ACCESS_KEY=***");
    expect(text).not.toContain("AK");
    expect(text).toContain("S3_ENDPOINT=http://minio:9000");
  });
});

// The list that decides whether the API exists at all on Cloudflare.
//
// Assets are served AHEAD of the Worker there, so a prefix missing from
// `run_worker_first` does not degrade — it returns the SPA `index.html` with a
// 200 while every other route looks healthy. 0.2.0 shipped that way because the
// list carried the wildcard form and not the bare one, and every collection
// endpoint answered with the SPA index. It took someone using the product to
// find it.
//
// It happened AGAIN on the collaborators branch: `/collab` was mounted in the
// API and never added here, so the entire collaborators feature — mint invite,
// list invites, revoke, list members, remove member — was dead on every
// Cloudflare install. The previous test could not catch it, because it pinned
// the literal list and then "verified the invariant" against a second
// hand-written list of prefixes. Both were correct about themselves. Neither
// was tied to the router.
//
// So this reads the ROUTER. `packages/api/src/index.ts` is the single source of
// truth for what is mounted; adding an `app.route()` there now fails this test
// until the deployable's list is updated.
//
// Reading the source text rather than importing the Hono app is deliberate:
// `@demo-locker/api` is not a dependency of this package and importing it would
// pull the Worker entrypoint, drizzle and the D1/R2 bindings into the CLI's
// test run to learn one fact that is plainly readable off the file. The parse
// is anchored on the exact `app.route("` call shape, so a mount that does not
// match it is not silently skipped — the count assertion below catches that.
describe("run_worker_first covers every mounted API prefix", () => {
  const indexPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "api",
    "src",
    "index.ts"
  );
  const source = readFileSync(indexPath, "utf8");
  const mounted = [...source.matchAll(/app\.route\(\s*"([^"]+)"/g)].map((m) => m[1]);

  const cfg = () => {
    const p = buildPlan(cfBase);
    const write = p.steps.find(
      (s): s is Extract<typeof p.steps[number], { kind: "write" }> =>
        s.kind === "write" && s.path.endsWith("wrangler.jsonc")
    )!;
    return JSON.parse(write.contents);
  };

  it("finds the mounts it is supposed to be checking", () => {
    // If the regex ever stops matching — the file reformats, someone mounts
    // with a template literal — this test must fail loudly rather than pass
    // vacuously over an empty list.
    expect(mounted.length).toBeGreaterThanOrEqual(7);
    expect(mounted).toContain("/collab");
    expect(mounted).toContain("/public/v1");
  });

  it("lists every mount in BOTH the bare and wildcard form", () => {
    const list: string[] = cfg().assets.run_worker_first;
    const missing = mounted.flatMap((prefix) =>
      [prefix, `${prefix}/*`].filter((form) => !list.includes(form))
    );
    expect(
      missing,
      `mounted in packages/api/src/index.ts but absent from API_PATHS in packages/cli/src/plan.ts — ` +
        `on Cloudflare these return the SPA index with a 200 instead of reaching the Worker`
    ).toEqual([]);
  });

  // The other direction: an entry here that no longer corresponds to a mount is
  // dead weight, and dead weight is how the list stops being read. `/health` is
  // the one legitimate non-mount — an `app.get` with no static asset to shadow
  // it. `/embed.js` and `/openapi.json` are `app.get`s too but are deliberately
  // NOT in the list: real files of those names ship in assets/public/, so the
  // assets layer answering them is correct.
  it("carries nothing that is not mounted, apart from /health", () => {
    const list: string[] = cfg().assets.run_worker_first;
    const allowed = new Set(["/health", ...mounted, ...mounted.map((p) => `${p}/*`)]);
    expect(list.filter((p) => !allowed.has(p))).toEqual([]);

    // Pin the two deliberate omissions, so a future reader who notices them
    // finds this test rather than "fixing" them.
    expect(list).not.toContain("/embed.js");
    expect(list).not.toContain("/openapi.json");
  });
});
