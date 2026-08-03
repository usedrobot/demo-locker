import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseD1List, workerNameFromD1, resolveInstance } from "../src/discover.js";
import type { Runner } from "../src/execute.js";

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
      hostIp: null,
      networkMode: null,
      image: "ghcr.io/usedrobot/demo-locker:latest",
      env: ["DATA_DIR=/data", "ALLOW_SIGNUP=true", "S3_BUCKET=demos"],
    });
  });

  // A container published with `-p 127.0.0.1:3001:3001` is deliberately NOT on
  // the LAN. Dropping HostIp republishes it on 0.0.0.0 — the upgrade reports
  // success while exposing a private locker to every machine on the network.
  it("carries a loopback-only HostIp through", () => {
    const loopback = JSON.stringify([
      {
        Id: "abc123def456",
        Name: "/demolocker",
        Config: { Image: "i", Env: [] },
        Mounts: [{ Type: "volume", Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostIp: "127.0.0.1", HostPort: "3001" }] } },
      },
    ]);
    expect(parseDockerInspect(loopback, "abc123def456")!.hostIp).toBe("127.0.0.1");
  });

  // 0.0.0.0 and "" both mean "every interface", which is `-p host:3001`'s own
  // default — carrying them through would only add noise.
  it("normalises a wildcard HostIp to null", () => {
    for (const ip of ["0.0.0.0", "", undefined]) {
      const json = JSON.stringify([
        {
          Id: "x", Name: "/x", Config: { Env: [] },
          Mounts: [{ Name: "demolocker", Destination: "/data" }],
          NetworkSettings: { Ports: { "3001/tcp": [{ HostIp: ip, HostPort: "3001" }] } },
        },
      ]);
      expect(parseDockerInspect(json, "x")!.hostIp).toBeNull();
    }
  });

  // A container we cannot name cannot be recreated: `docker run --name ""` is
  // not a faithful replacement, it is a differently-named orphan.
  it("returns null when the container has no name to recreate it under", () => {
    const noName = JSON.stringify([
      {
        Id: "x", Config: { Env: [] },
        Mounts: [{ Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      },
    ]);
    expect(parseDockerInspect(noName, "x")).toBeNull();
  });

  it("reads a custom NetworkMode", () => {
    const networked = JSON.stringify([
      {
        Id: "x", Name: "/x", Config: { Env: [] },
        HostConfig: { NetworkMode: "studio-net" },
        Mounts: [{ Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      },
    ]);
    expect(parseDockerInspect(networked, "x")!.networkMode).toBe("studio-net");
  });

  it("treats the default bridge network as no custom network", () => {
    for (const mode of ["default", "bridge", undefined]) {
      const json = JSON.stringify([
        {
          Id: "x", Name: "/x", Config: { Env: [] },
          HostConfig: { NetworkMode: mode },
          Mounts: [{ Name: "demolocker", Destination: "/data" }],
          NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
        },
      ]);
      expect(parseDockerInspect(json, "x")!.networkMode).toBeNull();
    }
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

  it("reads the port mapped to 3001/tcp even when it is not the first binding", () => {
    // Object.values order is not guaranteed — if 3001/tcp isn't first,
    // the old code would pick the wrong port. This container publishes
    // both 8000 and 8080, with 8000 first in the JSON and 8080 as the
    // 3001/tcp mapping.
    const multiPort = JSON.stringify([
      {
        Id: "abc123def456",
        Name: "/demolocker",
        Config: { Image: "i", Env: [] },
        Mounts: [{ Type: "volume", Name: "demolocker", Destination: "/data" }],
        NetworkSettings: {
          Ports: {
            "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "9000" }],
            "3001/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
          },
        },
      },
    ]);
    expect(parseDockerInspect(multiPort, "abc123def456")).toEqual({
      target: "docker",
      containerId: "abc123def456",
      containerName: "demolocker",
      volume: "demolocker",
      port: 8080,
      hostIp: null,
      networkMode: null,
      image: "i",
      env: [],
    });
  });
});

describe("env var alignment with bindings.ts", () => {
  it("every FORWARDED_ENV_VARS entry is matched by APP_ENV_EXACT_NAMES", () => {
    const __dirname = resolve(fileURLToPath(import.meta.url), "..");
    const bindingsPath = resolve(
      __dirname,
      "../../api/src/lib/bindings.ts"
    );
    const bindingsContent = readFileSync(bindingsPath, "utf-8");

    // Extract FORWARDED_ENV_VARS array from bindings.ts
    const match = bindingsContent.match(/export const FORWARDED_ENV_VARS = \[([\s\S]*?)\]/);
    expect(match, "Could not find FORWARDED_ENV_VARS in bindings.ts").toBeTruthy();

    const forwardedVars = (match![1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .map((line) => line.replace(/["',]/g, "").trim())
      .filter((line) => line && line !== "as const");

    // Check that all FORWARDED_ENV_VARS are in APP_ENV_EXACT_NAMES
    // (we can't import APP_ENV_EXACT_NAMES directly without creating a runtime
    // dependency, so we re-check the discover.ts file)
    const discoverPath = resolve(__dirname, "../src/discover.ts");
    const discoverContent = readFileSync(discoverPath, "utf-8");
    const exactNamesMatch = discoverContent.match(
      /const APP_ENV_EXACT_NAMES = \[([\s\S]*?)\]/
    );
    expect(
      exactNamesMatch,
      "Could not find APP_ENV_EXACT_NAMES in discover.ts"
    ).toBeTruthy();

    const appEnvExactNames = (exactNamesMatch![1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .map((line) => line.replace(/["',]/g, "").trim())
      .filter((line) => line);

    for (const varName of forwardedVars) {
      expect(
        appEnvExactNames,
        `FORWARDED_ENV_VARS entry "${varName}" not found in APP_ENV_EXACT_NAMES`
      ).toContain(varName);
    }
  });
});

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
  it("resolves the D1 id by name when given explicit flags, without full discovery probing", async () => {
    const runner = runnerWith({
      "npx wrangler d1 list": D1_JSON,
    });
    const res = await resolveInstance(
      { target: "cloudflare", workerName: "w", d1Name: "demo-locker-dlisok-db", r2Bucket: "r", domain: "h" },
      runner,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.instance).toMatchObject({ d1Id: "ca6096da-2ca9-4dfa-ba22-5f154cc0a322" });
    // Only the D1 lookup ran — not docker probing or the deployments/bucket checks.
    expect(runner.execCapture).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when the named D1 database cannot be found on this account", async () => {
    const runner = runnerWith({
      "npx wrangler d1 list": D1_JSON,
    });
    const res = await resolveInstance(
      { target: "cloudflare", workerName: "w", d1Name: "does-not-exist-db", r2Bucket: "r", domain: "h" },
      runner,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/does-not-exist-db/);
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

  // Identification must not depend on the container's image TAG. `docker ps
  // --filter ancestor=<repo>` resolves the tagless reference to <repo>:latest
  // and then matches by resolved image ID — so a container started from
  // <repo>:0.2.11 (which is what an upgrade now installs) stops matching once
  // the local `latest` tag points somewhere else, or is absent entirely. That
  // would make --upgrade work exactly once per instance.
  it("discovers a container running a version-tagged image, not just :latest", async () => {
    const versioned = JSON.stringify([
      {
        Id: "abc123def456",
        Name: "/demolocker",
        Config: { Image: "ghcr.io/usedrobot/demo-locker:0.2.11", Env: [] },
        Mounts: [{ Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      },
    ]);
    const runner = runnerWith({ "docker ps": "abc123def456\n", "docker inspect": versioned });
    const res = await resolveInstance({}, runner);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.instance).toMatchObject({ target: "docker", containerName: "demolocker" });
  });

  it("does not list containers by ancestor tag", async () => {
    const runner = runnerWith({ "docker ps": "abc123def456\n", "docker inspect": INSPECT_JSON });
    await resolveInstance({}, runner);
    const psCall = (runner.execCapture as unknown as { mock: { calls: [string, string[]][] } })
      .mock.calls.find(([cmd, args]) => cmd === "docker" && args[0] === "ps")!;
    expect(psCall[1].join(" ")).not.toContain("ancestor");
  });

  // Everything on the machine gets inspected now, so the repo check is the
  // only thing keeping unrelated containers out.
  it("ignores containers from a different image entirely", async () => {
    const other = JSON.stringify([
      {
        Id: "zzz", Name: "/postgres", Config: { Image: "postgres:16", Env: [] },
        Mounts: [{ Name: "pgdata", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      },
    ]);
    const runner = runnerWith({ "docker ps": "zzz\n", "docker inspect": other });
    const res = await resolveInstance({ target: "docker" }, runner);
    expect(res.ok).toBe(false);
  });

  // A repo whose name merely starts with ours is a different image.
  it("does not match a look-alike repo name", async () => {
    const lookalike = JSON.stringify([
      {
        Id: "zzz", Name: "/other", Config: { Image: "ghcr.io/usedrobot/demo-locker-staging:latest", Env: [] },
        Mounts: [{ Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      },
    ]);
    const runner = runnerWith({ "docker ps": "zzz\n", "docker inspect": lookalike });
    const res = await resolveInstance({ target: "docker" }, runner);
    expect(res.ok).toBe(false);
  });

  // An image pinned by digest is still our image.
  it("matches an image pinned by digest", async () => {
    const digest = JSON.stringify([
      {
        Id: "abc", Name: "/demolocker",
        Config: { Image: "ghcr.io/usedrobot/demo-locker@sha256:" + "a".repeat(64), Env: [] },
        Mounts: [{ Name: "demolocker", Destination: "/data" }],
        NetworkSettings: { Ports: { "3001/tcp": [{ HostPort: "3001" }] } },
      },
    ]);
    const runner = runnerWith({ "docker ps": "abc\n", "docker inspect": digest });
    const res = await resolveInstance({ target: "docker" }, runner);
    expect(res.ok).toBe(true);
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

  it("applies a partial override on top of a discovered instance", async () => {
    const runner = runnerWith({
      "npx wrangler d1 list": D1_JSON,
      "npx wrangler deployments list": "ok",
      "npx wrangler r2 bucket list": "demo-locker-demos",
    });
    const res = await resolveInstance({ target: "docker" }, runner);
    expect(res.ok).toBe(false); // target docker, no containers -> not found
  });

  // defaultRunner REJECTS when a binary is missing (spawn ENOENT), which is
  // useful for a step that genuinely needs the tool — but a probe is not that.
  // Without Docker installed, a --target cloudflare upgrade would die with
  // "could not run docker", which is most Cloudflare users.
  it("yields no candidates rather than throwing when a probe's tool is missing", async () => {
    const missing: Runner = {
      ...runnerWith({}),
      execCapture: vi.fn(async (cmd: string) => {
        throw new Error(`could not run "${cmd}" — is it installed and on PATH? (spawn ENOENT)`);
      }),
    };
    const res = await resolveInstance({}, missing);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/No Demo Locker instance found/);
  });

  it("still finds a cloudflare instance when docker is not installed", async () => {
    const noDocker: Runner = {
      ...runnerWith({
        "npx wrangler d1 list": D1_JSON,
        "npx wrangler deployments list": "ok",
        "npx wrangler r2 bucket list": "demo-locker-dlisok-demos\ndemo-locker-demos",
      }),
      execCapture: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "docker") throw new Error(`could not run "docker" (spawn ENOENT)`);
        const key = `${cmd} ${args.join(" ")}`;
        const responses: Record<string, string> = {
          "npx wrangler d1 list": D1_JSON,
          "npx wrangler deployments list": "ok",
          "npx wrangler r2 bucket list": "demo-locker-dlisok-demos",
        };
        const match = Object.keys(responses).find((k) => key.startsWith(k));
        return match ? { code: 0, stdout: responses[match] } : { code: 1, stdout: "" };
      }),
    };
    const res = await resolveInstance({ workerName: "demo-locker-dlisok" }, noDocker);
    expect(res.ok).toBe(true);
  });

  // The ambiguity error, AGENTS.md and docs/upgrading.md all advertise
  // --worker-name as the disambiguator. It has to actually disambiguate.
  describe("--worker-name", () => {
    const bothRunner = () =>
      runnerWith({
        "docker ps": "abc123def456\n",
        "docker inspect": INSPECT_JSON,
        "npx wrangler d1 list": D1_JSON,
        "npx wrangler deployments list": "ok",
        "npx wrangler r2 bucket list": "demo-locker-dlisok-demos\ndemo-locker-demos",
      });

    it("picks the matching worker out of several candidates", async () => {
      const res = await resolveInstance({ workerName: "demo-locker-dlisok" }, bothRunner());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.instance).toMatchObject({ target: "cloudflare", workerName: "demo-locker-dlisok" });
    });

    it("picks the other worker just as readily", async () => {
      const res = await resolveInstance({ workerName: "demo-locker" }, bothRunner());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.instance).toMatchObject({ workerName: "demo-locker" });
    });

    // Deploying over a different worker than the one named is exactly the
    // accident --worker-name exists to prevent.
    it("refuses rather than upgrading a single candidate that does not match", async () => {
      const runner = runnerWith({
        "npx wrangler d1 list": JSON.stringify([
          { uuid: "0ea573b2-861c-482c-a9c7-de5335d29fa0", name: "demo-locker-db" },
        ]),
        "npx wrangler deployments list": "ok",
        "npx wrangler r2 bucket list": "demo-locker-demos",
      });
      const res = await resolveInstance({ workerName: "some-other-worker" }, runner);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toMatch(/some-other-worker/);
        expect(res.candidates).toContain("cloudflare: demo-locker");
      }
    });

    it("refuses when only docker instances exist, since a Worker name cannot name one", async () => {
      const runner = runnerWith({ "docker ps": "abc123def456\n", "docker inspect": INSPECT_JSON });
      const res = await resolveInstance({ workerName: "demo-locker" }, runner);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/--worker-name/);
    });
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
