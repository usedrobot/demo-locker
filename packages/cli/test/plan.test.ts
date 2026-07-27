import { describe, it, expect } from "vitest";
import { buildPlan, renderPlan } from "../src/plan.js";
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
