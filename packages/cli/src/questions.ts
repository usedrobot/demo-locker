import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "./main.js";
import { ask, select } from "./prompts.js";

const MODES = ["instance", "player", "both"] as const;
const TARGETS = ["docker", "fly", "railway", "existing"] as const;
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
  yes: boolean;
  dryRun: boolean;
}

export interface Answers {
  mode: (typeof MODES)[number];
  target: (typeof TARGETS)[number] | null;
  storage: (typeof STORAGES)[number] | null;
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string; region: string } | null;
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

  if (playerOnly && url) {
    if (flags.target !== undefined) {
      throw new Error("--target has no effect when --mode player is used with --url");
    }
    // Pointing the player at an existing instance — nothing to deploy.
    return { mode, target: null, storage: null, s3: null, port, volume, url, signup: null, dryRun: flags.dryRun };
  }

  if (needsInstance) {
    target = await resolve<(typeof TARGETS)[number]>(flags.target, flags.yes, () =>
      select(io, "Where will it run?", [
        { value: "docker", label: "Docker on this machine (laptop, Pi, VPS — wherever you're running this)" },
        { value: "fly", label: "Fly.io (managed hosting, free-ish tier, needs flyctl)" },
        { value: "railway", label: "Railway (guided instructions)" },
        { value: "existing", label: "I already have an instance running" },
      ], "docker"), "docker");

    if (flags.url && target !== "existing") {
      throw new Error("--url is only valid with --target existing or --mode player");
    }

    if (target === "existing") {
      url = flags.url ?? (flags.yes ? null : await askUrl(io, "Instance URL (e.g. https://demos.example.com)?"));
      if (!url) throw new Error("--url is required for --target existing");
      return { mode, target, storage: null, s3: null, port, volume, url, signup: null, dryRun: flags.dryRun };
    }

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

    if (target === "docker") {
      if (flags.port !== undefined) {
        port = parsePort(flags.port);
      } else if (flags.yes) {
        port = 3001;
      } else {
        port = await askPort(io, "3001");
      }
      volume = flags.volume ?? (flags.yes ? "demolocker" : await ask(io, "Docker volume name (your music lives here)?", "demolocker"));
    }

    if (target === "fly" || target === "railway") {
      io.output.write(
        "Note: account creation isn't automated for this target — sign up in the app after deploy.\n",
      );
      signup = null;
    } else if (flags.email && flags.password) {
      validatePassword(flags.password);
      signup = { email: flags.email, password: flags.password };
    } else if (!flags.yes) {
      const email = await ask(io, "Create the first account now? Email (empty to skip):", "");
      if (email) signup = { email, password: await askPassword(io) };
    }
  }

  return { mode, target, storage, s3, port, volume, url, signup, dryRun: flags.dryRun };
}
