import { describe, it, expect } from "vitest";
import { buildUpgradePlan } from "../src/upgrade.js";
import type { DiscoveredInstance, DockerCandidate } from "../src/discover.js";
import { cliVersion, versionedImage } from "../src/plan.js";
import type { DeployPlan, Step } from "../src/plan.js";

const cf: DiscoveredInstance = {
  target: "cloudflare", workerName: "demo-locker-dlisok", d1Name: "demo-locker-dlisok-db",
  d1Id: "ca6096da", r2Bucket: "demo-locker-dlisok-demos", domain: "demolocker.dlisok.com",
};
// Typed as the narrow DockerCandidate, not DiscoveredInstance: these tests
// read docker-only fields, and the narrow type also makes the compiler point
// at this fixture whenever the candidate shape changes.
const dk: DockerCandidate = {
  target: "docker", containerId: "abc123", containerName: "demolocker",
  volume: "demolocker", port: 8080, hostIp: null, networkMode: null,
  image: "ghcr.io/usedrobot/demo-locker:0.2.10",
  env: ["ALLOW_SIGNUP=true"],
};

const runs = (p: Step[] | DeployPlan) =>
  (Array.isArray(p) ? p : p.steps).filter(
    (s): s is Extract<Step, { kind: "run" }> => s.kind === "run",
  );

describe("buildUpgradePlan cloudflare", () => {
  it("applies migrations BEFORE deploying", () => {
    const args = runs(buildUpgradePlan(cf, "/tmp/stage").steps).map((s) => s.args.join(" "));
    const apply = args.findIndex((a) => a.includes("migrations apply"));
    const deploy = args.findIndex((a) => a.includes("deploy"));
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(apply).toBeLessThan(deploy);
  });

  // `migrations apply` exits 0 when its confirm prompt is declined, so the
  // plan re-checks and gates the deploy on that check's real output.
  it("verifies migrations are actually applied between apply and deploy", () => {
    const steps = buildUpgradePlan(cf, "/tmp/stage").steps;
    const kinds = steps.map((s) => (s.kind === "note" ? "note" : `${s.kind}:${"args" in s ? s.args.join(" ") : ""}`));
    const apply = kinds.findIndex((k) => k.includes("migrations apply"));
    const verify = steps.findIndex((s) => s.kind === "run-assert");
    const deploy = kinds.findIndex((k) => k.startsWith("run:wrangler deploy"));
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(apply);
    expect(deploy).toBeGreaterThan(verify);
    const check = steps[verify] as Extract<Step, { kind: "run-assert" }>;
    expect(check.args.join(" ")).toContain("migrations list");
    expect(check.args).toContain("--remote");
    expect("No migrations to apply!").toMatch(new RegExp(check.pattern));
  });

  it("writes a wrangler config naming the discovered resources", () => {
    const write = buildUpgradePlan(cf, "/tmp/stage").steps.find(
      (s): s is Extract<Step, { kind: "write" }> => s.kind === "write",
    )!;
    expect(write.contents).toContain("demo-locker-dlisok-db");
    expect(write.contents).toContain("demo-locker-dlisok-demos");
    expect(write.contents).toContain("demolocker.dlisok.com");
  });

  // Cloudflare enables workers.dev by default for any deploy config with no
  // routes block. This instance already has routes (asserted above), but
  // `workers_dev: false` is written explicitly too — belt-and-suspenders so a
  // config bug or a wrangler default change can't silently turn on a second,
  // public front door for what may be a private instance. See task-7-report.md
  // for why discovery can't yet distinguish "no custom domain" from "domain
  // unknown", which is why buildUpgradePlan refuses outright below rather than
  // ever emitting a routes-less upgrade config.
  //
  // `preview_urls` must go with it. In wrangler 4.80.0, getSubdomainValues()
  // computes `workers_dev = config.workers_dev ?? (routes.length === 0)` but
  // `preview_urls = config.preview_urls ?? undefined`, and subdomainDeploy()
  // then POSTs `previews_enabled: undefined` — which JSON.stringify DROPS, so
  // the server keeps whatever Preview URLs setting the Worker already had.
  // Disabling workers.dev therefore does NOT disable Preview URLs, and
  // wrangler's own warning about that combination is skipped under
  // isNonInteractiveOrCI() — exactly how this CLI drives it. Both keys, always.
  it("writes workers_dev: false AND preview_urls: false into the upgrade config", () => {
    const write = buildUpgradePlan(cf, "/tmp/stage").steps.find(
      (s): s is Extract<Step, { kind: "write" }> => s.kind === "write",
    )!;
    const config = JSON.parse(write.contents.replace("__DATABASE_ID__", cf.d1Id));
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
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
  // this is the common path, not an edge case. A routes-less upgrade config
  // gets workers.dev enabled by Cloudflare's own default — silently exposing
  // what may be a private instance at a second, public URL. Refusing outright
  // is the fix (see task-7-report.md): an upgrade that stops and asks beats
  // one that "succeeds" by publishing something it was never told to expose.
  it("refuses to build a plan when the domain is unknown, naming --domain as the fix", () => {
    const noDomain = { ...cf, domain: null };
    expect(() => buildUpgradePlan(noDomain, "/tmp/stage")).toThrow(/--domain/);
    expect(() => buildUpgradePlan(noDomain, "/tmp/stage")).toThrow(/workers\.dev/);
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

  // Republishing a loopback-bound container on 0.0.0.0 would put a private
  // locker on the LAN while the upgrade reports success.
  it("preserves a loopback-only publish address", () => {
    const bound: DockerCandidate = { ...dk, hostIp: "127.0.0.1" };
    const run = runs(buildUpgradePlan(bound, "/tmp/stage")).find((s) => s.args[0] === "run")!;
    expect(run.args).toContain("127.0.0.1:8080:3001");
    expect(run.args).not.toContain("8080:3001");
  });

  it("omits the host ip when the container was published on every interface", () => {
    const run = runs(buildUpgradePlan(dk, "/tmp/stage")).find((s) => s.args[0] === "run")!;
    expect(run.args).toContain("8080:3001");
  });

  // stop → rm → run has no way back: if `run` fails, the old container is gone.
  // Renaming keeps it recoverable until the new one is proven healthy.
  it("renames the old container instead of removing it before starting the new one", () => {
    const plan = buildUpgradePlan(dk, "/tmp/stage");
    const args = runs(plan).map((s) => s.args.join(" "));
    const rename = args.findIndex((a) => a.startsWith("rename"));
    const run = args.findIndex((a) => a.startsWith("run"));
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(args[rename]).toContain("demolocker-preupgrade");
    expect(rename).toBeLessThan(run);
    expect(args.some((a) => a.startsWith("rm"))).toBe(false);
  });

  it("removes the renamed old container only after the health check passes", () => {
    const plan = buildUpgradePlan(dk, "/tmp/stage");
    const after = (plan.afterHealthySteps ?? []).filter(
      (s): s is Extract<Step, { kind: "run" }> => s.kind === "run",
    );
    expect(after.map((s) => s.args.join(" "))).toContain("rm demolocker-preupgrade");
    for (const s of after) expect(s.args).not.toContain("-v");
  });

  // The failed NEW container still holds the name and the port, so a bare
  // rename would fail on a name conflict and the start would fail on the port.
  it("carries a rollback command that removes the failed container first", () => {
    const hint = buildUpgradePlan(dk, "/tmp/stage").rollbackHint!;
    expect(hint).toContain("docker rm -f demolocker");
    expect(hint).toContain("docker rename demolocker-preupgrade demolocker");
    expect(hint).toContain("docker start demolocker");
    expect(hint.indexOf("rm -f demolocker")).toBeLessThan(hint.indexOf("rename demolocker-preupgrade"));
    expect(hint.indexOf("rename demolocker-preupgrade")).toBeLessThan(hint.indexOf("start demolocker"));
    // Never anywhere near the volume.
    expect(hint).not.toMatch(/-v\b|volume rm/);
  });

  it("never passes -v to any removal, before or after health", () => {
    const plan = buildUpgradePlan(dk, "/tmp/stage");
    for (const s of [...plan.steps, ...(plan.afterHealthySteps ?? [])]) {
      if (s.kind === "run") expect(s.args).not.toContain("-v:");
      if (s.kind === "run" && (s.args[0] === "rm" || s.args[0] === "volume")) {
        expect(s.args).not.toContain("-v");
        expect(s.args.join(" ")).not.toContain("volume rm");
      }
    }
  });

  // Recreating a container attached to a user-defined network onto the default
  // bridge makes it unreachable by every peer that resolves it by name.
  it("refuses when the container is on a custom network", () => {
    const networked: DockerCandidate = { ...dk, networkMode: "studio-net" };
    expect(() => buildUpgradePlan(networked, "/tmp/stage")).toThrow(/studio-net/);
    expect(() => buildUpgradePlan(networked, "/tmp/stage")).toThrow(/by hand|manually/i);
  });

  it("refuses to build a plan for a container with no name", () => {
    const unnamed: DockerCandidate = { ...dk, containerName: "" };
    expect(() => buildUpgradePlan(unnamed, "/tmp/stage")).toThrow(/name/i);
  });

  // The spec: "the version you upgrade to is the CLI version you run".
  it("pulls and runs an image tagged with the CLI's own version", () => {
    const plan = buildUpgradePlan(dk, "/tmp/stage");
    const args = runs(plan).map((s) => s.args.join(" "));
    expect(args.some((a) => a === `pull ${versionedImage()}`)).toBe(true);
    expect(runs(plan).find((s) => s.args[0] === "run")!.args).toContain(versionedImage());
    expect(versionedImage()).toContain(cliVersion());
    expect(versionedImage()).not.toContain(":latest");
  });

  // main.ts resolves the tag against the registry first and passes :latest here
  // when the versioned tag does not exist.
  it("honours an explicitly supplied image", () => {
    const plan = buildUpgradePlan(dk, "/tmp/stage", { image: "ghcr.io/usedrobot/demo-locker:latest" });
    expect(runs(plan).map((s) => s.args.join(" "))).toContain("pull ghcr.io/usedrobot/demo-locker:latest");
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

// MAX_COLLABORATORS used to cap share links per playlist and now caps
// collaborator seats; MAX_SHARE_LINKS took over the old job. `upgrade`
// re-passes the operator's value verbatim, so this is the one moment their
// setting silently starts doing something else — and the only moment we can
// say so outside release notes.
describe("buildUpgradePlan docker — MAX_COLLABORATORS meaning change", () => {
  const notes = (p: DeployPlan) =>
    p.steps.filter((s): s is Extract<Step, { kind: "note" }> => s.kind === "note").map((s) => s.text);

  it("warns when the instance carries MAX_COLLABORATORS", () => {
    const withLimit: DockerCandidate = { ...dk, env: ["ALLOW_SIGNUP=true", "MAX_COLLABORATORS=10"] };
    const text = notes(buildUpgradePlan(withLimit, "/tmp/stage")).join("\n");

    expect(text).toContain("MAX_COLLABORATORS");
    expect(text).toContain("MAX_SHARE_LINKS");
    expect(text).toMatch(/changed meaning/i);
    // The notice has to precede the work, not trail it.
    const plan = buildUpgradePlan(withLimit, "/tmp/stage");
    expect(plan.steps.findIndex((s) => s.kind === "note")).toBeLessThan(
      plan.steps.findIndex((s) => s.kind === "run"),
    );
    // Warning about it must not stop it being carried across.
    expect(runs(plan).find((s) => s.args[0] === "run")!.args).toContain("MAX_COLLABORATORS=10");
  });

  it("says nothing when the instance does not set it", () => {
    expect(notes(buildUpgradePlan(dk, "/tmp/stage"))).toEqual([]);
    // Not fooled by a variable that merely starts with the same characters.
    const other: DockerCandidate = { ...dk, env: ["MAX_COLLABORATORS_X=1"] };
    expect(notes(buildUpgradePlan(other, "/tmp/stage"))).toEqual([]);
  });
});
