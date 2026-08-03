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
