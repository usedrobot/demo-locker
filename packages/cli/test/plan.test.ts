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

describe("buildPlan fly", () => {
  it("writes fly.toml then launch/volume/deploy", () => {
    const p = buildPlan({ ...base, target: "fly" });
    expect(p.steps[0]).toMatchObject({ kind: "write", path: "fly.toml" });
    const cmds = p.steps.filter((s): s is Extract<typeof p.steps[number], {kind:"run"}> => s.kind === "run").map((s) => s.args.join(" "));
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
