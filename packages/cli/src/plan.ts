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
