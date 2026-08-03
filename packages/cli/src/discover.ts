// Finding an instance that already exists.
//
// Discovery runs before planning, not as plan steps: `run-capture` in
// execute.ts hardcodes D1-id extraction and cannot parse arbitrary output.
// These probes take the injected Runner so they stay testable without a real
// account or daemon.

import type { Runner } from "./execute.js";
import { IMAGE } from "./plan.js";

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

export type DiscoveredInstance = DockerCandidate | CloudflareCandidate;

export interface ResolveOptions {
  target?: "cloudflare" | "docker" | "existing";
  workerName?: string;
  d1Name?: string;
  r2Bucket?: string;
  domain?: string;
}

export type ResolveResult =
  | { ok: true; instance: DiscoveredInstance }
  | { ok: false; reason: string; candidates: string[] };

const IMAGE_NAME = IMAGE.split(":")[0];

export async function probeDocker(runner: Runner): Promise<DockerCandidate[]> {
  const { code, stdout } = await runner.execCapture("docker", [
    "ps", "-a", "--filter", `ancestor=${IMAGE_NAME}`, "--format", "{{.ID}}",
  ]);
  if (code !== 0) return [];
  const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const found: DockerCandidate[] = [];
  for (const id of ids) {
    const res = await runner.execCapture("docker", ["inspect", id]);
    if (res.code !== 0) continue;
    const c = parseDockerInspect(res.stdout, id);
    if (c) found.push(c);
  }
  return found;
}

export async function probeCloudflare(runner: Runner): Promise<CloudflareCandidate[]> {
  const list = await runner.execCapture("npx", ["wrangler", "d1", "list", "--json"]);
  if (list.code !== 0) return [];
  const buckets = await runner.execCapture("npx", ["wrangler", "r2", "bucket", "list"]);

  const found: CloudflareCandidate[] = [];
  for (const db of parseD1List(list.stdout)) {
    const workerName = workerNameFromD1(db.name);
    if (!workerName) continue;
    // A derived name is a guess until the Worker is confirmed to exist.
    const check = await runner.execCapture("npx", ["wrangler", "deployments", "list", "--name", workerName]);
    if (check.code !== 0) continue;
    const bucket = `${workerName}-demos`;
    found.push({
      target: "cloudflare",
      workerName,
      d1Name: db.name,
      d1Id: db.id,
      r2Bucket: buckets.code === 0 && buckets.stdout.includes(bucket) ? bucket : null,
      domain: null,
    });
  }
  return found;
}

/**
 * A supplied flag always beats a discovered value, including when only some
 * are supplied — `--domain` alone must still take effect on an otherwise
 * discovered instance.
 */
function applyOverrides(inst: DiscoveredInstance, opts: ResolveOptions): DiscoveredInstance {
  if (inst.target !== "cloudflare") return inst;
  return {
    ...inst,
    d1Name: opts.d1Name ?? inst.d1Name,
    r2Bucket: opts.r2Bucket ?? inst.r2Bucket,
    domain: opts.domain ?? inst.domain,
  };
}

/**
 * Explicit flags win outright and skip probing. Otherwise probe both targets;
 * exactly one hit resolves, anything else is an error that names the
 * candidates. Nothing here ever picks on the user's behalf — an upgrade writes
 * to something that already exists and holds data.
 */
export async function resolveInstance(opts: ResolveOptions, runner: Runner): Promise<ResolveResult> {
  if (opts.target === "cloudflare" && opts.workerName) {
    const workerName = opts.workerName;
    const d1Name = opts.d1Name ?? `${workerName}-db`;
    // The explicit-flag path skips discovery, but the D1 id itself is never
    // supplied on the command line — it has to be looked up by name.
    // cloudflareUpgrade substitutes this into wrangler.jsonc's database_id, so
    // an unresolved id here (falling back to "") would ship a Worker pointed
    // at no database at all.
    const list = await runner.execCapture("npx", ["wrangler", "d1", "list", "--json"]);
    const match = list.code === 0 ? parseD1List(list.stdout).find((d) => d.name === d1Name) : undefined;
    if (!match) {
      return {
        ok: false,
        candidates: [],
        reason:
          `No D1 database named "${d1Name}" was found on this account. ` +
          `Pass --d1-name to match the database wrangler actually created, or check \`npx wrangler d1 list\`.`,
      };
    }
    return {
      ok: true,
      instance: {
        target: "cloudflare",
        workerName,
        d1Name,
        d1Id: match.id,
        r2Bucket: opts.r2Bucket ?? `${workerName}-demos`,
        domain: opts.domain ?? null,
      },
    };
  }

  const docker = opts.target === "cloudflare" ? [] : await probeDocker(runner);
  const cloud = opts.target === "docker" ? [] : await probeCloudflare(runner);
  const all: DiscoveredInstance[] = [...docker, ...cloud];

  // A partial override still overrides. Discovery fills the rest.
  if (all.length === 1) return { ok: true, instance: applyOverrides(all[0], opts) };
  if (all.length === 0) {
    return {
      ok: false,
      candidates: [],
      reason:
        `No Demo Locker instance found.\n` +
        `  docker:     looked for a container from ${IMAGE_NAME}\n` +
        `  cloudflare: looked for a D1 database named <worker>-db with a deployed Worker\n` +
        `If your instance runs somewhere else (Fly, Railway, a VPS), upgrade it by ` +
        `redeploying the image — see docs/upgrading.md.`,
    };
  }
  return {
    ok: false,
    candidates: all.map((c) => (c.target === "docker" ? `docker: ${c.containerName}` : `cloudflare: ${c.workerName}`)),
    reason: "More than one Demo Locker instance found. Disambiguate with --target or --worker-name.",
  };
}
