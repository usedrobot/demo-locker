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
  const config = wranglerConfig({
    workerName: cf.workerName,
    d1Name: cf.d1Name,
    r2Bucket: cf.r2Bucket ?? `${cf.workerName}-demos`,
    domain: cf.domain,
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

  const appUrl = cf.domain ? `https://${cf.domain}` : null;
  return { steps, healthUrl: appUrl ? `${appUrl}/health` : null, appUrl };
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
