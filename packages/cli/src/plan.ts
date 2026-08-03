import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Answers } from "./questions.js";

/** The published image, without a tag. */
export const IMAGE_REPO = "ghcr.io/usedrobot/demo-locker";

/** A fresh install always takes the newest release. */
export const IMAGE = `${IMAGE_REPO}:latest`;

/**
 * This CLI's own version — read exactly the way `--version` reads it, so the
 * two can never disagree.
 */
export function cliVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("../package.json") as { version: string }).version;
}

/**
 * The image tag an upgrade should move to. The spec's promise is that "the
 * version you upgrade to is the CLI version you run", so `npx
 * demo-locker@0.2.9 --upgrade` must install 0.2.9, not latest. main.ts checks
 * the tag exists before using it and falls back to IMAGE otherwise.
 */
export function versionedImage(version: string = cliVersion()): string {
  return `${IMAGE_REPO}:${version}`;
}

export type Step =
  | { kind: "run"; title: string; cmd: string; args: string[] }
  | { kind: "run-capture"; title: string; cmd: string; args: string[]; capture: string }
  /**
   * Run a read-only command and gate everything after it on what it PRINTS,
   * not just on its exit code. Needed because some tools report "I did
   * nothing" with a zero exit — `wrangler d1 migrations apply` exits 0 when
   * the user answers "n" to its confirm prompt, which would otherwise let the
   * deploy step run against an unmigrated database.
   *
   * Fails closed: if stdout does not match `pattern`, the plan stops.
   */
  | {
      kind: "run-assert";
      title: string;
      cmd: string;
      args: string[];
      /** Regular-expression source stdout must match for the plan to continue. */
      pattern: string;
      /** Shown when it does not match. Explain what is wrong and what to do. */
      failure: string;
    }
  | { kind: "write"; title: string; path: string; contents: string }
  | { kind: "copy"; title: string; from: string; to: string }
  | { kind: "note"; text: string };

export interface DeployPlan {
  steps: Step[];
  healthUrl: string | null;
  appUrl: string | null;
  /**
   * Steps that run only once healthUrl answers — cleanup that must not happen
   * while the new deployment might still need rolling back. The docker upgrade
   * uses this to remove the renamed pre-upgrade container.
   */
  afterHealthySteps?: Step[];
}

/** Directory the deployable is unpacked into, relative to the user's cwd. */
export const ASSETS_DIR = "demo-locker";

/**
 * The prebuilt deployable shipped inside the npm tarball: worker.js, public/,
 * and migrations/. Built by scripts/build-assets.sh. Resolved from this
 * module's own location — at runtime that is dist/plan.js, so the assets sit
 * one level up at <package>/assets. Resolving a path is not filesystem access,
 * so buildPlan stays pure.
 */
const PACKAGED_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

/** Alias for upgrade.ts, which stages the same packaged deployable. */
export const PACKAGED_ASSETS_FOR_UPGRADE = PACKAGED_ASSETS;

// Every mounted API prefix needs BOTH the bare path and the wildcard.
// `/playlists/*` does not match bare `/playlists` — verified against a real
// Worker: with only the wildcard, `/playlists/x` reaches the Worker but
// `/playlists` falls through to the assets layer and gets the SPA index. That
// broke create-playlist, list-playlists and the track library on every fresh
// Cloudflare install of 0.2.0, while every sub-path looked fine. Collection
// endpoints live at the bare paths, so leaving one out silently breaks a verb.
const API_PATHS = [
  "/health",
  "/auth",
  "/auth/*",
  "/playlists",
  "/playlists/*",
  "/comments",
  "/comments/*",
  "/shares",
  "/shares/*",
  "/tracks",
  "/tracks/*",
  "/public/v1",
  "/public/v1/*",
];

export function wranglerConfig(cf: {
  workerName: string;
  d1Name: string;
  r2Bucket: string;
  domain: string | null;
  // Explicit opt-out only. Left undefined, Cloudflare's own default applies
  // (workers.dev enabled whenever there is no routes block) — correct for a
  // fresh install with no custom domain. Pass `false` when the instance is
  // known to live at a custom domain (see upgrade.ts): belt-and-suspenders
  // alongside `routes` so a config bug or a future wrangler default change
  // can't silently turn on a second, public front door.
  //
  // `false` writes `preview_urls: false` too, and that is not optional.
  // wrangler 4.80.0 `getSubdomainValues` defaults workers_dev from the routes
  // block but defaults preview_urls to `undefined`; `subdomainDeploy` then
  // POSTs `previews_enabled: undefined`, which JSON.stringify omits, so the
  // account keeps whatever Preview URLs setting it already had. Turning off
  // workers.dev without saying anything about preview_urls therefore leaves a
  // per-version *.workers.dev URL live. wrangler warns about exactly this
  // combination — but not under isNonInteractiveOrCI(), which is how the CLI
  // runs it. Writing both keys is the only way to actually close both doors.
  workersDev?: boolean;
}): string {
  const config: Record<string, unknown> = {
    name: cf.workerName,
    main: "worker.js",
    compatibility_date: "2024-12-01",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_name: cf.d1Name,
        database_id: "__DATABASE_ID__",
        migrations_dir: "migrations",
      },
    ],
    r2_buckets: [{ binding: "DEMOS_BUCKET", bucket_name: cf.r2Bucket }],
    assets: {
      directory: "public",
      not_found_handling: "single-page-application",
      run_worker_first: API_PATHS,
    },
  };
  if (cf.domain) {
    config.routes = [{ pattern: cf.domain, custom_domain: true }];
  }
  if (cf.workersDev === false) {
    config.workers_dev = false;
    config.preview_urls = false;
  }
  return JSON.stringify(config, null, 2) + "\n";
}

const EXPOSE_NOTES: Step[] = [
  { kind: "note", text: "" },
  { kind: "note", text: "To reach this from outside the machine, pick one:" },
  { kind: "note", text: "  cloudflared — free https on your own domain, no open ports:" },
  { kind: "note", text: "    brew install cloudflared   # or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" },
  { kind: "note", text: "    cloudflared tunnel login" },
  { kind: "note", text: "    cloudflared tunnel create demolocker" },
  { kind: "note", text: "    cloudflared tunnel route dns demolocker demos.example.com" },
  { kind: "note", text: "    cloudflared tunnel run --url http://localhost:PORT demolocker" },
  { kind: "note", text: "  caddy — if the machine already has a public IP and DNS:" },
  { kind: "note", text: "    caddy reverse-proxy --from demos.example.com --to localhost:PORT" },
  { kind: "note", text: "  lan only — reachable at http://<this-machine-ip>:PORT, no setup needed." },
  { kind: "note", text: "    Note: browsers treat plain http as an insecure context, which disables" },
  { kind: "note", text: "    clipboard and some upload features. https via one of the above avoids that." },
];

export function buildPlan(a: Answers): DeployPlan {
  switch (a.target) {
    case "docker": {
      const envArgs: string[] = [];
      if (a.s3) {
        const e = a.s3;
        for (const [k, v] of [
          ["S3_ENDPOINT", e.endpoint], ["S3_ACCESS_KEY", e.accessKey],
          ["S3_SECRET_KEY", e.secretKey], ["S3_BUCKET", e.bucket], ["S3_REGION", e.region],
        ]) envArgs.push("-e", `${k}=${v}`);
      }
      const appUrl = `http://localhost:${a.port}`;
      return {
        steps: [
          { kind: "run", title: "Create data volume", cmd: "docker", args: ["volume", "create", a.volume] },
          {
            kind: "run", title: "Start Demo Locker", cmd: "docker",
            args: [
              "run", "-d", "--name", a.volume, "--restart", "unless-stopped",
              "-v", `${a.volume}:/data`, "-p", `${a.port}:3001`, ...envArgs, IMAGE,
            ],
          },
          ...EXPOSE_NOTES.map((n) =>
            n.kind === "note" ? { ...n, text: n.text.replaceAll("PORT", String(a.port)) } : n,
          ),
        ],
        healthUrl: `${appUrl}/health`,
        appUrl,
      };
    }
    case "cloudflare": {
      const cf = a.cloudflare;
      if (!cf) {
        // A zero-step plan would make the wizard report success having deployed
        // nothing. collectAnswers always fills this in for the cloudflare target.
        throw new Error("internal error: --target cloudflare reached buildPlan with no cloudflare answers");
      }
      const appUrl = cf.domain ? `https://${cf.domain}` : null;
      return {
        steps: [
          {
            kind: "copy",
            title: `Unpack Demo Locker (worker, web app, migrations) into ${ASSETS_DIR}/`,
            from: PACKAGED_ASSETS,
            to: ASSETS_DIR,
          },
          {
            kind: "note",
            text: "R2 storage needs billing enabled on your Cloudflare account. The free tier still applies, but a card must be on file — otherwise bucket creation fails below.",
          },
          { kind: "run", title: "Check Cloudflare login", cmd: "wrangler", args: ["whoami"] },
          {
            kind: "run-capture", title: "Create D1 database", cmd: "wrangler",
            args: ["d1", "create", cf.d1Name], capture: "DATABASE_ID",
          },
          {
            kind: "run", title: "Create R2 bucket", cmd: "wrangler",
            args: ["r2", "bucket", "create", cf.r2Bucket],
          },
          {
            kind: "write", title: "Write wrangler.jsonc",
            path: `${ASSETS_DIR}/wrangler.jsonc`, contents: wranglerConfig(cf),
          },
          {
            kind: "run", title: "Apply database migrations", cmd: "wrangler",
            args: ["d1", "migrations", "apply", cf.d1Name, "--remote", "--config", `${ASSETS_DIR}/wrangler.jsonc`],
          },
          {
            kind: "run", title: "Deploy", cmd: "wrangler",
            args: ["deploy", "--config", `${ASSETS_DIR}/wrangler.jsonc`],
          },
        ],
        healthUrl: appUrl ? `${appUrl}/health` : null,
        appUrl,
      };
    }
    case "existing":
      return {
        steps: [],
        healthUrl: a.url ? `${a.url.replace(/\/$/, "")}/health` : null,
        appUrl: a.url,
      };
    case null:
      // The player-only-with-url path never reaches buildPlan (see main.ts);
      // anything else that gets here has no target and nothing to deploy.
      throw new Error("no deploy target — pass --target, or use --mode player --url <instance-url>");
    default: {
      const _exhaustive: never = a.target;
      throw new Error(`unhandled target: ${String(_exhaustive)}`);
    }
  }
}

function redactEnvArg(arg: string): string {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(arg);
  if (m && /SECRET|ACCESS_KEY/.test(m[1])) return `${m[1]}=***`;
  return arg;
}

export function renderPlan(p: DeployPlan): string {
  const render = (s: Step) => {
    if (s.kind === "run" || s.kind === "run-capture" || s.kind === "run-assert") {
      return `$ ${s.cmd} ${s.args.map(redactEnvArg).join(" ")}`;
    }
    if (s.kind === "write") return `write ${s.path}`;
    if (s.kind === "copy") return `copy ${s.from} → ${s.to}`;
    return `# ${s.text}`;
  };
  const lines = p.steps.map(render);
  if (p.healthUrl) lines.push(`then wait for ${p.healthUrl}`);
  lines.push(...(p.afterHealthySteps ?? []).map(render));
  return lines.join("\n") + "\n";
}
