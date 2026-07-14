import type { Answers } from "./questions.js";

export const IMAGE = "ghcr.io/usedrobot/demo-locker:latest";

export type Step =
  | { kind: "run"; title: string; cmd: string; args: string[] }
  | { kind: "write"; title: string; path: string; contents: string }
  | { kind: "note"; text: string };

export interface DeployPlan {
  steps: Step[];
  healthUrl: string | null;
  appUrl: string | null;
}

const FLY_TOML = `# Fly.io deploy for the Demo Locker standalone image.
app = "demo-locker"
primary_region = "mia"

[build]
  image = "${IMAGE}"

[mounts]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
`;

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
    case "fly":
      return {
        steps: [
          { kind: "write", title: "Write fly.toml", path: "fly.toml", contents: FLY_TOML },
          { kind: "run", title: "Create fly app", cmd: "fly", args: ["launch", "--copy-config", "--no-deploy"] },
          { kind: "run", title: "Create data volume", cmd: "fly", args: ["volumes", "create", "data", "--size", "3"] },
          { kind: "run", title: "Deploy", cmd: "fly", args: ["deploy"] },
          { kind: "note", text: "fly prints your app URL above — open it and sign up; the first account in wins." },
        ],
        healthUrl: null,
        appUrl: null,
      };
    case "railway":
      return {
        steps: [
          { kind: "note", text: "Railway can't be driven headlessly from here. In the Railway dashboard:" },
          { kind: "note", text: `1. New Project → Deploy a Docker image → ${IMAGE}` },
          { kind: "note", text: "2. Add a volume mounted at /data" },
          { kind: "note", text: "3. Settings → Networking → expose port 3001" },
          { kind: "note", text: "4. Open the generated URL and sign up — first account in wins." },
        ],
        healthUrl: null,
        appUrl: null,
      };
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
    if (s.kind === "write") return `write ${s.path}`;
    return `# ${s.text}`;
  });
  if (p.healthUrl) lines.push(`then wait for ${p.healthUrl}`);
  return lines.join("\n") + "\n";
}
