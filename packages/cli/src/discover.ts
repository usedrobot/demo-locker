// Finding an instance that already exists.
//
// Discovery runs before planning, not as plan steps: `run-capture` in
// execute.ts hardcodes D1-id extraction and cannot parse arbitrary output.
// These probes take the injected Runner so they stay testable without a real
// account or daemon.

import type { Runner } from "./execute.js";
import { IMAGE_REPO } from "./plan.js";

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
  /**
   * The interface the app port is published on, or null for "all of them".
   * `-p 127.0.0.1:3001:3001` is a deliberate choice not to be on the LAN, and
   * recreating it as plain `-p 3001:3001` would publish a private locker to
   * every machine on the network while reporting success.
   */
  hostIp: string | null;
  /**
   * The image reference the container was created from, verbatim — tag,
   * digest or bare repo. Identification matches on the repo part only: a
   * container upgraded to `<repo>:0.2.11` must stay discoverable next time.
   */
  image: string;
  /**
   * A user-defined network the container is attached to, or null for the
   * default bridge. Recreating a network-attached container onto the default
   * bridge makes it unreachable by the peers that resolve it by name, so
   * upgrade.ts refuses rather than silently detaching it.
   */
  networkMode: string | null;
  env: string[];
}

/** Docker's own spellings for "no user-defined network". */
const DEFAULT_NETWORK_MODES = new Set(["", "default", "bridge"]);

/** Docker's spellings for "published on every interface". */
const WILDCARD_HOST_IPS = new Set(["", "0.0.0.0", "::"]);

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
interface InspectRow {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Env?: string[] };
  HostConfig?: { NetworkMode?: string };
  Mounts?: Array<{ Name?: string; Destination?: string }>;
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

function parseRows(stdout: string): InspectRow[] {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? (parsed as InspectRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * Every candidate `docker inspect` reported, in one go. `docker inspect a b c`
 * answers with one array, so the whole machine costs a single spawn.
 */
export function parseDockerInspectAll(stdout: string): DockerCandidate[] {
  const out: DockerCandidate[] = [];
  for (const row of parseRows(stdout)) {
    // Without an id there is nothing to stop, rename or remove.
    if (!row.Id) continue;
    const c = candidateFromRow(row, row.Id);
    if (c) out.push(c);
  }
  return out;
}

export function parseDockerInspect(stdout: string, containerId: string): DockerCandidate | null {
  const row = parseRows(stdout)[0];
  return row ? candidateFromRow(row, containerId) : null;
}

function candidateFromRow(row: InspectRow, containerId: string): DockerCandidate | null {
  const dataMount = (row.Mounts ?? []).find((m) => m.Destination === "/data");
  if (!dataMount?.Name) return null;

  // Without a name there is nothing to recreate the container as: `docker run
  // --name ""` is rejected outright, and guessing one would orphan the old
  // container rather than replace it.
  const containerName = (row.Name ?? "").replace(/^\//, "");
  if (!containerName) return null;

  const bindings = row.NetworkSettings?.Ports ?? {};
  const appPortBinding = bindings["3001/tcp"];
  const hostPort = appPortBinding?.[0]?.HostPort;
  const port = Number(hostPort);
  const hostIp = appPortBinding?.[0]?.HostIp ?? "";
  const networkMode = row.HostConfig?.NetworkMode ?? "";

  return {
    target: "docker",
    containerId,
    containerName,
    volume: dataMount.Name,
    port: Number.isInteger(port) && port > 0 ? port : 3001,
    hostIp: WILDCARD_HOST_IPS.has(hostIp) ? null : hostIp,
    image: row.Config?.Image ?? "",
    networkMode: DEFAULT_NETWORK_MODES.has(networkMode) ? null : networkMode,
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

/**
 * Run a probe command, treating "the tool isn't here" as "found nothing".
 *
 * defaultRunner.execCapture REJECTS on spawn ENOENT, which is the right
 * behaviour for a step that genuinely needs the tool — but a probe asking
 * "is there a docker instance?" on a machine with no docker has its answer,
 * and letting that reject would abort a perfectly valid Cloudflare upgrade.
 */
async function probeCapture(
  runner: Runner,
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  try {
    return await runner.execCapture(cmd, args);
  } catch {
    return { code: 127, stdout: "" };
  }
}

/**
 * Is this the Demo Locker image, whatever it is tagged or pinned as?
 *
 * Matching on the repo alone is the whole point. `<repo>-staging:latest` is a
 * different image and must not match, so the repo has to be followed by a tag
 * separator, a digest separator, or nothing at all.
 */
export function isDemoLockerImage(image: string): boolean {
  return (
    image === IMAGE_REPO ||
    image.startsWith(`${IMAGE_REPO}:`) ||
    image.startsWith(`${IMAGE_REPO}@`)
  );
}

/**
 * Find containers running this image, by INSPECTING them — never by
 * `--filter ancestor=`.
 *
 * The ancestor filter resolves a tagless reference to `<repo>:latest` and then
 * matches on the resolved image ID, not on the name. Since an upgrade installs
 * `<repo>:<cli version>` and does not move the local `latest` tag, an
 * ancestor-filtered probe stops seeing an instance as soon as it has been
 * upgraded once — and sees nothing at all on a machine that has no local
 * `latest`. Reading `Config.Image` and comparing the repo is tag-agnostic and
 * survives any future tag scheme.
 *
 * The cost is inspecting every container on the machine, which is one extra
 * `docker inspect` argument list rather than one extra spawn — `docker inspect
 * a b c` answers with a single array.
 */
export async function probeDocker(runner: Runner): Promise<DockerCandidate[]> {
  const { code, stdout } = await probeCapture(runner, "docker", [
    "ps", "-a", "--format", "{{.ID}}",
  ]);
  if (code !== 0) return [];
  const ids = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  const res = await probeCapture(runner, "docker", ["inspect", ...ids]);
  if (res.code !== 0) return [];
  return parseDockerInspectAll(res.stdout).filter((c) => isDemoLockerImage(c.image));
}

export async function probeCloudflare(runner: Runner): Promise<CloudflareCandidate[]> {
  const list = await probeCapture(runner, "npx", ["wrangler", "d1", "list", "--json"]);
  if (list.code !== 0) return [];
  const buckets = await probeCapture(runner, "npx", ["wrangler", "r2", "bucket", "list"]);

  const found: CloudflareCandidate[] = [];
  for (const db of parseD1List(list.stdout)) {
    const workerName = workerNameFromD1(db.name);
    if (!workerName) continue;
    // A derived name is a guess until the Worker is confirmed to exist.
    const check = await probeCapture(runner, "npx", ["wrangler", "deployments", "list", "--name", workerName]);
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
 * discovered instance. workerName is included for completeness: resolveInstance
 * only ever reaches here with a candidate that already matches it, but nothing
 * downstream should depend on that being true.
 */
function applyOverrides(inst: DiscoveredInstance, opts: ResolveOptions): DiscoveredInstance {
  if (inst.target !== "cloudflare") return inst;
  return {
    ...inst,
    workerName: opts.workerName ?? inst.workerName,
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
    const list = await probeCapture(runner, "npx", ["wrangler", "d1", "list", "--json"]);
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
  const discovered: DiscoveredInstance[] = [...docker, ...cloud];

  // --worker-name is advertised as THE disambiguator (by the ambiguity error
  // below, by AGENTS.md and by docs/upgrading.md), so it has to select, not
  // merely decorate. Filtering also closes the worse hole: with exactly one
  // discovered instance, an unmatched --worker-name used to be ignored
  // outright and the upgrade went to whatever was found — deploying over a
  // worker the user did not name.
  const all = opts.workerName
    ? discovered.filter((c) => c.target === "cloudflare" && c.workerName === opts.workerName)
    : discovered;

  if (opts.workerName && all.length === 0 && discovered.length > 0) {
    return {
      ok: false,
      candidates: describe(discovered),
      reason:
        `No Demo Locker instance matching --worker-name "${opts.workerName}" was found. ` +
        `Discovery found these instead:`,
    };
  }

  // A partial override still overrides. Discovery fills the rest.
  if (all.length === 1) return { ok: true, instance: applyOverrides(all[0], opts) };
  if (all.length === 0) {
    return {
      ok: false,
      candidates: [],
      reason:
        `No Demo Locker instance found.\n` +
        `  docker:     looked for a container from ${IMAGE_REPO}\n` +
        `  cloudflare: looked for a D1 database named <worker>-db with a deployed Worker\n` +
        `If your instance runs somewhere else (Fly, Railway, a VPS), upgrade it by ` +
        `redeploying the image — see docs/upgrading.md.`,
    };
  }
  return {
    ok: false,
    candidates: describe(all),
    reason: "More than one Demo Locker instance found. Disambiguate with --target or --worker-name.",
  };
}

function describe(all: DiscoveredInstance[]): string[] {
  return all.map((c) =>
    c.target === "docker" ? `docker: ${c.containerName}` : `cloudflare: ${c.workerName}`,
  );
}
