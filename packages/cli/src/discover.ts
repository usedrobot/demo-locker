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

export interface DockerCandidate {
  target: "docker";
  containerId: string;
  containerName: string;
  volume: string;
  port: number;
  env: string[];
}

/**
 * Exact environment variable names the app owns. These are compared by exact name.
 * See packages/api/src/lib/bindings.ts — FORWARDED_ENV_VARS is the source of truth
 * for config that survives an upgrade. DATA_DIR and PORT are self-hosted-specific.
 */
const APP_ENV_EXACT_NAMES = [
  "DATA_DIR",
  "PORT",
  "ALLOW_SIGNUP",
  "MAX_UPLOAD_BYTES",
  "MAX_STORAGE_BYTES",
  "MAX_PLAYLISTS",
  "MAX_COLLABORATORS",
];

/**
 * Environment variable prefixes the app owns. These are matched by startsWith.
 * Everything else in Config.Env belongs to the image (PATH, NODE_VERSION, …)
 * and re-passing it to `docker run` would override the new image's own values.
 */
const APP_ENV_PREFIXES = ["S3_"];

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
  const appPortBinding = bindings["3001/tcp"];
  const hostPort = appPortBinding?.[0]?.HostPort;
  const port = Number(hostPort);

  return {
    target: "docker",
    containerId,
    containerName: (row.Name ?? "").replace(/^\//, ""),
    volume: dataMount.Name,
    port: Number.isInteger(port) && port > 0 ? port : 3001,
    env: (row.Config?.Env ?? []).filter(
      (e) =>
        APP_ENV_EXACT_NAMES.some((name) => e.startsWith(name + "=")) ||
        APP_ENV_PREFIXES.some((p) => e.startsWith(p))
    ),
  };
}
