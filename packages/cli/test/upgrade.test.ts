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

  // The whole point of resolving the id (rather than reusing the empty-id
  // short-circuit) is that it actually ends up in the deployed config. A
  // Worker bound to the literal string "__DATABASE_ID__" is a silent no-op
  // deploy against no database at all.
  it("substitutes the real D1 id and leaves no placeholder behind", () => {
    const write = buildUpgradePlan(cf, "/tmp/stage").steps.find(
      (s): s is Extract<Step, { kind: "write" }> => s.kind === "write",
    )!;
    expect(write.contents).toContain("ca6096da");
    expect(write.contents).not.toContain("__DATABASE_ID__");
  });

  it("refuses to build a plan when the D1 id is unresolved", () => {
    const noId = { ...cf, d1Id: "" };
    expect(() => buildUpgradePlan(noId, "/tmp/stage")).toThrow(/demo-locker-dlisok-db/);
  });

  it("refuses to build a plan when the R2 bucket is unresolved", () => {
    const noBucket = { ...cf, r2Bucket: null };
    expect(() => buildUpgradePlan(noBucket, "/tmp/stage")).toThrow(/demo-locker-dlisok-demos|r2|bucket/i);
  });

  it("creates nothing, but still runs the expected upgrade verbs", () => {
    const args = runs(buildUpgradePlan(cf, "/tmp/stage").steps).map((s) => s.args.join(" "));
    expect(args.some((a) => a.includes("d1 create"))).toBe(false);
    expect(args.some((a) => a.includes("r2 bucket create"))).toBe(false);
    // Anchor: an empty step list would also pass the assertions above.
    expect(args.some((a) => a.includes("migrations apply"))).toBe(true);
    expect(args.some((a) => a.includes("deploy"))).toBe(true);
  });

  // probeCloudflare never discovers a domain (it always sets domain: null), so
  // this is the common path, not an edge case. Deploying a routes-less config
  // over a Worker that already has a custom-domain route must not silently
  // report success without ever having checked the new version is live.
  it("surfaces that no health check will run when the domain is unknown", () => {
    const noDomain = { ...cf, domain: null };
    const plan = buildUpgradePlan(noDomain, "/tmp/stage");
    expect(plan.healthUrl).toBeNull();
    const notes = plan.steps.filter((s): s is Extract<Step, { kind: "note" }> => s.kind === "note");
    expect(notes.some((n) => /health/i.test(n.text) && /--domain/.test(n.text))).toBe(true);
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

  // A wrong or default --name here starts the new container under a different
  // name than the old one, orphaning it rather than replacing it.
  it("starts the new container under the same name as the old one", () => {
    const run = runs(buildUpgradePlan(dk, "/tmp/stage").steps).find((s) => s.args[0] === "run")!;
    const nameIdx = run.args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(run.args[nameIdx + 1]).toBe(dk.containerName);
  });

  it("has no migration step — the image migrates on boot", () => {
    const args = runs(buildUpgradePlan(dk, "/tmp/stage").steps).map((s) => s.args.join(" "));
    expect(args.some((a) => a.includes("migrations"))).toBe(false);
  });

  it("creates nothing beyond the running container — no new volume, no forced removal", () => {
    const args = runs(buildUpgradePlan(dk, "/tmp/stage").steps).map((s) => s.args.join(" "));
    expect(args.some((a) => a.includes("volume create"))).toBe(false);
    expect(args.some((a) => a.startsWith("rm") && a.includes("-f"))).toBe(false);
    // Anchor: an empty step list would also pass the assertions above.
    expect(args.some((a) => a.startsWith("pull"))).toBe(true);
    expect(args.some((a) => a.startsWith("run"))).toBe(true);
  });
});
