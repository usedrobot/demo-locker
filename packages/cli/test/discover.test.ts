import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
