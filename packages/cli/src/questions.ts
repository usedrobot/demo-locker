import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "./main.js";
import { ask, select } from "./prompts.js";

const MODES = ["instance", "player", "both"] as const;
const TARGETS = ["cloudflare", "docker", "existing"] as const;
const STORAGES = ["local", "s3"] as const;

export interface Flags {
  mode?: (typeof MODES)[number];
  target?: (typeof TARGETS)[number];
  storage?: (typeof STORAGES)[number];
  port?: string;
  volume?: string;
  url?: string;
  email?: string;
  password?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Region?: string;
  workerName?: string;
  d1Name?: string;
  r2Bucket?: string;
  domain?: string;
  upgrade: boolean;
  yes: boolean;
  dryRun: boolean;
}

export interface Answers {
  mode: (typeof MODES)[number];
  target: (typeof TARGETS)[number] | null;
  storage: (typeof STORAGES)[number] | null;
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string; region: string } | null;
  cloudflare: { workerName: string; d1Name: string; r2Bucket: string; domain: string | null } | null;
  port: number;
  volume: string;
  url: string | null;
  signup: { email: string; password: string } | null;
  dryRun: boolean;
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

/** Parse and validate a port string. Throws on invalid input. */
function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port must be an integer 1-65535 (got "${raw}")`);
  }
  return port;
}

/** Validate a URL has a scheme. Throws on invalid input. Returns the URL unchanged. */
function validateUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "must include a scheme, e.g. https://demos.example.com or http://192.168.1.10:3001",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "must include a scheme, e.g. https://demos.example.com or http://192.168.1.10:3001",
    );
  }
  return raw;
}

/**
 * Validate a bare hostname (no scheme, no path, no port). Throws on invalid input.
 * Returns the hostname lowercased — it ends up in wrangler routes, the health/app
 * URLs, and the embed snippet written into the user's project, all of which should
 * be canonical regardless of how the user typed it.
 */
function validateHostname(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes("/")) {
    throw new Error(
      "must be a bare hostname, e.g. demos.example.com (not a URL)",
    );
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw)) {
    throw new Error("must be a bare hostname, e.g. demos.example.com");
  }
  return raw.toLowerCase();
}

export function parseFlags(argv: string[]): Flags {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
      target: { type: "string" },
      storage: { type: "string" },
      port: { type: "string" },
      volume: { type: "string" },
      url: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      "s3-endpoint": { type: "string" },
      "s3-bucket": { type: "string" },
      "s3-access-key": { type: "string" },
      "s3-secret-key": { type: "string" },
      "s3-region": { type: "string" },
      "worker-name": { type: "string" },
      "d1-name": { type: "string" },
      "r2-bucket": { type: "string" },
      domain: { type: "string" },
      upgrade: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (v.port !== undefined) {
    try {
      parsePort(v.port);
    } catch (e) {
      throw new Error(`--port ${(e as Error).message}`);
    }
  }

  if (v.url !== undefined) {
    try {
      validateUrl(v.url);
    } catch (e) {
      throw new Error(`--url ${(e as Error).message}`);
    }
  }

  if (v.domain !== undefined) {
    try {
      validateHostname(v.domain);
    } catch (e) {
      throw new Error(`--domain ${(e as Error).message}`);
    }
  }

  // Install-only flags describe resources to CREATE. On upgrade every one of
  // them is already fixed by the running instance, so accepting them would
  // silently imply we can change something we cannot.
  if (v.upgrade) {
    const installOnly = ["mode", "storage", "port", "volume", "url", "email"] as const;
    const offenders = installOnly.filter((k) => v[k] !== undefined);
    if (offenders.length > 0) {
      throw new Error(
        `--upgrade cannot be combined with: ${offenders.map((o) => `--${o}`).join(", ")}. ` +
          `Those describe a new install; an upgrade reuses what the instance already has.`,
      );
    }
  }

  return {
    mode: oneOf("mode", v.mode, MODES),
    target: oneOf("target", v.target, TARGETS),
    storage: oneOf("storage", v.storage, STORAGES),
    port: v.port,
    volume: v.volume,
    url: v.url,
    email: v.email,
    password: v.password,
    s3Endpoint: v["s3-endpoint"],
    s3Bucket: v["s3-bucket"],
    s3AccessKey: v["s3-access-key"],
    s3SecretKey: v["s3-secret-key"],
    s3Region: v["s3-region"],
    workerName: v["worker-name"],
    d1Name: v["d1-name"],
    r2Bucket: v["r2-bucket"],
    domain: v.domain,
    upgrade: v.upgrade ?? false,
    yes: v.yes ?? false,
    dryRun: v["dry-run"] ?? false,
  };
}

export function detectContext(cwd: string): "web-project" | "empty" {
  return existsSync(join(cwd, "package.json")) ? "web-project" : "empty";
}

/** Answer a question from a flag, or the default (--yes), or by prompting. */
async function resolve<T extends string>(
  flagValue: T | undefined,
  yes: boolean,
  promptFn: () => Promise<T>,
  def: T,
): Promise<T> {
  if (flagValue !== undefined) return flagValue;
  if (yes) return def;
  return promptFn();
}

/** Prompt for a port, looping until valid. */
async function askPort(io: IO, defaultPort: string): Promise<number> {
  while (true) {
    const raw = await ask(io, "Host port?", defaultPort);
    try {
      return parsePort(raw);
    } catch {
      io.output.write("Please enter an integer 1-65535.\n");
    }
  }
}

/** Prompt for an instance URL, looping until it has a valid scheme. */
async function askUrl(io: IO, question: string): Promise<string> {
  while (true) {
    const raw = await ask(io, question);
    try {
      return validateUrl(raw);
    } catch (e) {
      io.output.write(`${(e as Error).message}\n`);
    }
  }
}

/**
 * Prompt for a custom domain, looping until it is a valid bare hostname.
 * An empty answer means "no custom domain" — a workers.dev URL — not an error.
 */
async function askDomain(io: IO): Promise<string | null> {
  while (true) {
    const raw = await ask(io, "Custom domain? (blank for a workers.dev URL)", "");
    if (raw === "") return null;
    try {
      return validateHostname(raw);
    } catch (e) {
      io.output.write(`${(e as Error).message}\n`);
    }
  }
}

/** Validate a password. Throws on invalid input. */
function validatePassword(pw: string): void {
  if (pw.length < 8) {
    throw new Error("--password must be at least 8 characters");
  }
}

/** Prompt for a password, looping until valid. */
async function askPassword(io: IO): Promise<string> {
  while (true) {
    const pw = await ask(io, "Password? (input will be visible)");
    try {
      validatePassword(pw);
      return pw;
    } catch {
      io.output.write("Password must be at least 8 characters.\n");
    }
  }
}

export async function collectAnswers(
  flags: Flags,
  io: IO,
  context: "web-project" | "empty",
): Promise<Answers> {
  const defaultMode = context === "web-project" ? "both" : "instance";
  const mode = await resolve<(typeof MODES)[number]>(flags.mode, flags.yes, () =>
    select(io, "What do you need?", [
      { value: "instance", label: "A Demo Locker — editable playlists your band can comment on" },
      { value: "player", label: "A public-facing player added to this project" },
      { value: "both", label: "Both — the locker plus an embedded public player" },
    ], defaultMode), defaultMode);

  const needsInstance = mode !== "player" || flags.url === undefined;
  const playerOnly = mode === "player";

  let target: Answers["target"] = null;
  let storage: Answers["storage"] = null;
  let s3: Answers["s3"] = null;
  let url: string | null = flags.url ?? null;
  let port = Number(flags.port ?? 3001);
  let volume = flags.volume ?? "demolocker";
  let signup: Answers["signup"] = null;
  let cloudflare: Answers["cloudflare"] = null;

  if (playerOnly && url) {
    if (flags.target !== undefined) {
      throw new Error("--target has no effect when --mode player is used with --url");
    }
    // Pointing the player at an existing instance — nothing to deploy.
    return { mode, target: null, storage: null, s3: null, cloudflare: null, port, volume, url, signup: null, dryRun: flags.dryRun };
  }

  if (needsInstance) {
    target = await resolve<(typeof TARGETS)[number]>(flags.target, flags.yes, () =>
      select(io, "Where will it run?", [
        { value: "cloudflare", label: "Cloudflare (Workers + D1 + R2 — free tier, works from anywhere)" },
        { value: "docker", label: "Docker on this machine (laptop, Pi, VPS — wherever you're running this)" },
        { value: "existing", label: "I already have an instance running" },
      ], "docker"), "docker");

    if (flags.url && target !== "existing") {
      throw new Error("--url is only valid with --target existing or --mode player");
    }

    const cfFlags: [string, string | undefined][] = [
      ["domain", flags.domain], ["worker-name", flags.workerName],
      ["d1-name", flags.d1Name], ["r2-bucket", flags.r2Bucket],
    ];
    for (const [name, value] of cfFlags) {
      if (value !== undefined && target !== "cloudflare") {
        throw new Error(`--${name} is only valid with --target cloudflare`);
      }
    }

    // The mirror of the check above: the docker-shaped flags mean nothing on
    // Cloudflare (the Worker has no host port and no volume), so reject them
    // rather than silently ignoring what the user asked for.
    const dockerFlags: [string, string | undefined][] = [
      ["port", flags.port], ["volume", flags.volume],
    ];
    for (const [name, value] of dockerFlags) {
      if (value !== undefined && target === "cloudflare") {
        throw new Error(`--${name} is not valid with --target cloudflare`);
      }
    }

    if (target === "existing") {
      url = flags.url ?? (flags.yes ? null : await askUrl(io, "Instance URL (e.g. https://demos.example.com)?"));
      if (!url) throw new Error("--url is required for --target existing");
      return { mode, target, storage: null, s3: null, cloudflare: null, port, volume, url, signup: null, dryRun: flags.dryRun };
    }

    if (target === "cloudflare") {
      const domain = flags.domain !== undefined
        ? validateHostname(flags.domain)
        : flags.yes ? null : await askDomain(io);
      cloudflare = {
        workerName: flags.workerName ?? "demo-locker",
        d1Name: flags.d1Name ?? "demo-locker-db",
        r2Bucket: flags.r2Bucket ?? "demo-locker-demos",
        domain,
      };
    } else {
      storage = await resolve<(typeof STORAGES)[number]>(flags.storage, flags.yes, () =>
        select(io, "Where should audio files live?", [
          { value: "local", label: "Local disk (inside the data volume — simplest, back up one folder)" },
          { value: "s3", label: "S3-compatible bucket (R2, B2, MinIO, AWS)" },
        ], "local"), "local");

      if (storage === "s3") {
        const need = async (flag: string | undefined, name: string, q: string, def?: string) => {
          if (flag !== undefined) return flag;
          if (flags.yes) {
            if (def !== undefined) return def;
            throw new Error(`--storage s3 with --yes requires --${name}`);
          }
          return ask(io, q, def);
        };
        s3 = {
          endpoint: await need(flags.s3Endpoint, "s3-endpoint", "S3 endpoint URL?"),
          accessKey: await need(flags.s3AccessKey, "s3-access-key", "S3 access key?"),
          secretKey: await need(flags.s3SecretKey, "s3-secret-key", "S3 secret key?"),
          bucket: await need(flags.s3Bucket, "s3-bucket", "Bucket name?", "demos"),
          region: await need(flags.s3Region, "s3-region", "Region?", "auto"),
        };
      }

      // Only the docker target reaches here (existing returned above, cloudflare
      // took the branch above), so no target check is needed.
      if (flags.port !== undefined) {
        port = parsePort(flags.port);
      } else if (flags.yes) {
        port = 3001;
      } else {
        port = await askPort(io, "3001");
      }
      volume = flags.volume ?? (flags.yes ? "demolocker" : await ask(io, "Docker volume name (your music lives here)?", "demolocker"));
    }

    // On Cloudflare without a custom domain the app lives at a workers.dev URL
    // that is not knowable until wrangler has deployed, so there is nothing to
    // POST a signup to. Asking would silently throw the credential away.
    const noKnownUrl = target === "cloudflare" && !cloudflare?.domain;
    if (noKnownUrl && (flags.email !== undefined || flags.password !== undefined)) {
      throw new Error(
        "--email/--password need a reachable URL, but --target cloudflare without --domain " +
        "deploys to a workers.dev URL that is not known until after the deploy. " +
        "Re-run with --domain <host>, or open the workers.dev URL afterwards and sign up there.",
      );
    }

    if (flags.email && flags.password) {
      validatePassword(flags.password);
      signup = { email: flags.email, password: flags.password };
    } else if (!flags.yes && !noKnownUrl) {
      const email = await ask(io, "Create the first account now? Email (empty to skip):", "");
      if (email) signup = { email, password: await askPassword(io) };
    }
  }

  return { mode, target, storage, s3, cloudflare, port, volume, url, signup, dryRun: flags.dryRun };
}
