// Upgrading an instance that already exists. Creates nothing.

import { join } from "node:path";
import { IMAGE, PACKAGED_ASSETS_FOR_UPGRADE, wranglerConfig } from "./plan.js";
import type { DeployPlan, Step } from "./plan.js";
import type { DiscoveredInstance } from "./discover.js";

export function buildUpgradePlan(instance: DiscoveredInstance, stagingDir: string): DeployPlan {
  return instance.target === "docker"
    ? dockerUpgrade(instance)
    : cloudflareUpgrade(instance, stagingDir);
}

function cloudflareUpgrade(
  cf: Extract<DiscoveredInstance, { target: "cloudflare" }>,
  stagingDir: string,
): DeployPlan {
  // All three guards below must run before a single step is built: cloudflareUpgrade
  // substitutes these values straight into wrangler.jsonc, and by the time
  // `migrations apply` has run against the live D1, it is too late to back out.
  if (!cf.d1Id) {
    throw new Error(
      `internal error: cannot upgrade "${cf.d1Name}" — no D1 database id was resolved for it. ` +
        `This is a bug in discovery, not something a flag can work around.`,
    );
  }
  if (!cf.r2Bucket) {
    throw new Error(
      `cannot upgrade "${cf.workerName}": no R2 bucket named "${cf.workerName}-demos" (or matching ` +
        `--r2-bucket) could be found on this account. Fix the bucket first, or pass --r2-bucket <name>.`,
    );
  }
  // Discovery can't yet learn a Worker's custom domain (no read-only wrangler
  // command reports it — see task-7-report.md). Without a known domain this
  // function cannot emit a `routes` block, and Cloudflare's default for a
  // routes-less config is to enable workers.dev for the deploy — silently
  // giving what may be a private instance a second, public URL. Refusing and
  // naming the fix is safer than an upgrade that "succeeds" by exposing it.
  if (!cf.domain) {
    throw new Error(
      `cannot upgrade "${cf.workerName}": no custom domain is known for this instance. Deploying without ` +
        `one would omit its routes, and Cloudflare enables workers.dev by default for a routes-less config — ` +
        `that would publish this instance at a second, public *.workers.dev URL alongside its real domain. ` +
        `Pass --domain <host> naming the instance's actual custom domain and re-run the upgrade.`,
    );
  }

  const config = wranglerConfig({
    workerName: cf.workerName,
    d1Name: cf.d1Name,
    r2Bucket: cf.r2Bucket,
    domain: cf.domain,
    // Belt-and-suspenders alongside `routes` above — see the comment on
    // wranglerConfig's workersDev param.
    workersDev: false,
  }).replace("__DATABASE_ID__", cf.d1Id);

  const configPath = join(stagingDir, "wrangler.jsonc");
  const steps: Step[] = [
    { kind: "copy", title: "Stage the new build", from: PACKAGED_ASSETS_FOR_UPGRADE, to: stagingDir },
    { kind: "write", title: "Write wrangler config for this instance", path: configPath, contents: config },
    {
      kind: "run",
      title: "Check for pending migrations (read-only)",
      cmd: "npx",
      args: ["wrangler", "d1", "migrations", "list", cf.d1Name, "--remote", "--config", configPath],
    },
    // MUST precede deploy: the ORM selects every column explicitly, so a Worker
    // running ahead of its migration breaks every read of any table that
    // gained a column. Asserted by a test, not left to step order by luck.
    {
      kind: "run",
      title: "Apply migrations",
      cmd: "npx",
      args: ["wrangler", "d1", "migrations", "apply", cf.d1Name, "--remote", "--config", configPath],
    },
    {
      kind: "run",
      title: "Deploy the new version",
      cmd: "npx",
      args: ["wrangler", "deploy", "--config", configPath],
    },
  ];

  // cf.domain is guaranteed truthy here — the guard above refuses to build a
  // plan otherwise — so the health check always has a URL to poll.
  const appUrl = `https://${cf.domain}`;
  return { steps, healthUrl: `${appUrl}/health`, appUrl };
}

function dockerUpgrade(dk: Extract<DiscoveredInstance, { target: "docker" }>): DeployPlan {
  const envArgs = dk.env.flatMap((e) => ["-e", e]);
  const steps: Step[] = [
    { kind: "run", title: "Pull the new image", cmd: "docker", args: ["pull", IMAGE] },
    { kind: "run", title: "Stop the running container", cmd: "docker", args: ["stop", dk.containerId] },
    // NEVER -v. That deletes the volume holding every uploaded master.
    { kind: "run", title: "Remove the old container", cmd: "docker", args: ["rm", dk.containerId] },
    {
      kind: "run",
      title: "Start the new container on the same volume",
      cmd: "docker",
      args: [
        "run", "-d", "--name", dk.containerName, "--restart", "unless-stopped",
        "-v", `${dk.volume}:/data`, "-p", `${dk.port}:3001`,
        ...envArgs,
        IMAGE,
      ],
    },
  ];
  const appUrl = `http://localhost:${dk.port}`;
  return { steps, healthUrl: `${appUrl}/health`, appUrl };
}
