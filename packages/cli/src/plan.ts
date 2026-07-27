import type { Answers } from "./questions.js";

export const IMAGE = "ghcr.io/usedrobot/demo-locker:latest";

export type Step =
  | { kind: "run"; title: string; cmd: string; args: string[] }
  | { kind: "run-capture"; title: string; cmd: string; args: string[]; capture: string }
  | { kind: "write"; title: string; path: string; contents: string }
  | { kind: "note"; text: string };

export interface DeployPlan {
  steps: Step[];
  healthUrl: string | null;
  appUrl: string | null;
}

export const ASSETS_DIR = "demo-locker";

const API_PATHS = [
  "/health",
  "/auth/*",
  "/playlists/*",
  "/comments/*",
  "/shares/*",
  "/tracks/*",
  "/public/v1/*",
];

function wranglerConfig(cf: NonNullable<Answers["cloudflare"]>): string {
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
  return JSON.stringify(config, null, 2) + "\n";
}

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
        ],
        healthUrl: `${appUrl}/health`,
        appUrl,
      };
    }
    case "cloudflare": {
      const cf = a.cloudflare;
      if (!cf) return { steps: [], healthUrl: null, appUrl: null };
      const appUrl = cf.domain ? `https://${cf.domain}` : null;
      return {
        steps: [
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
    default:
      return { steps: [], healthUrl: null, appUrl: a.url };
  }
}

function redactEnvArg(arg: string): string {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(arg);
  if (m && /SECRET|ACCESS_KEY/.test(m[1])) return `${m[1]}=***`;
  return arg;
}

export function renderPlan(p: DeployPlan): string {
  const lines = p.steps.map((s) => {
    if (s.kind === "run") return `$ ${s.cmd} ${s.args.map(redactEnvArg).join(" ")}`;
    if (s.kind === "run-capture") return `$ ${s.cmd} ${s.args.map(redactEnvArg).join(" ")}`;
    if (s.kind === "write") return `write ${s.path}`;
    return `# ${s.text}`;
  });
  if (p.healthUrl) lines.push(`then wait for ${p.healthUrl}`);
  return lines.join("\n") + "\n";
}
