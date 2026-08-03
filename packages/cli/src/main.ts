import { createRequire } from "node:module";
import { parseFlags, detectContext, collectAnswers } from "./questions.js";
import { buildPlan, renderPlan } from "./plan.js";
import { executePlan, defaultRunner } from "./execute.js";
import type { Runner } from "./execute.js";
import { setupPlayer } from "./embed.js";
import { resolveInstance } from "./discover.js";
import { buildUpgradePlan } from "./upgrade.js";
import { ask } from "./prompts.js";

export interface IO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const USAGE = `Usage: npx demo-locker [options]

Sets up a Demo Locker — self-hosted music streaming for demos and mixes.

Options:
  --mode <instance|player|both>   what to set up
  --target <cloudflare|docker|existing>   where the instance runs
  --storage <local|s3>            where audio files live (docker target)
  --port <n>                      host port for docker target (default 3001)
  --volume <name>                 docker volume name (default demolocker)
  --url <https://...>             existing instance URL (player/existing)
  --email <addr> --password <pw>  create the first account after boot
  --s3-endpoint --s3-bucket --s3-access-key --s3-secret-key --s3-region
  --domain <host>                 custom domain for the cloudflare target
                                  (omit for a workers.dev URL)
  --worker-name <name>            cloudflare Worker name (default demo-locker)
  --d1-name <name>                cloudflare D1 database name (default demo-locker-db)
  --r2-bucket <name>              cloudflare R2 bucket name (default demo-locker-demos)
  --upgrade                       update an existing instance in place
  --yes                           accept defaults for unanswered questions
  --dry-run                       print the deploy plan without running it
  --help, --version
`;

export async function main(
  argv: string[],
  io: IO,
  deps: { runner?: Runner; cwd?: string } = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.output.write(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    const require = createRequire(import.meta.url);
    io.output.write(require("../package.json").version + "\n");
    return 0;
  }

  const cwd = deps.cwd ?? process.cwd();
  const runner = deps.runner ?? defaultRunner(io);

  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    io.output.write(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    return 1;
  }

  if (flags.upgrade) {
    return runUpgrade(flags, io, runner);
  }

  let answers;
  try {
    answers = await collectAnswers(flags, io, detectContext(cwd));
  } catch (err) {
    io.output.write(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    return 1;
  }

  const wantsInstance = answers.mode === "instance" || answers.mode === "both";
  const wantsPlayer = answers.mode === "player" || answers.mode === "both";

  let instanceUrl = answers.url;
  let deployedInstance = false;

  if (wantsInstance || (wantsPlayer && answers.target)) {
    const plan = buildPlan(answers);
    if (answers.dryRun) {
      let out = renderPlan(plan);
      if (wantsPlayer) out += `then: player setup in ${cwd}\n`;
      io.output.write(out);
      return 0;
    }
    const code = await executePlan(plan, answers.signup, io, runner);
    if (code !== 0) return code;
    instanceUrl = plan.appUrl ?? instanceUrl;
    deployedInstance = true;
  }

  if (wantsPlayer) {
    if (!instanceUrl) {
      if (deployedInstance) {
        io.output.write(
          "Once you know your instance URL, wire the player with: npx demo-locker --mode player --url <your-instance-url>\n",
        );
        return 0;
      }
      io.output.write("No instance URL known — pass --url or deploy an instance first.\n");
      return 1;
    }
    if (answers.dryRun) {
      io.output.write(
        `dry-run: would install @demo-locker/player and print embed snippets for ${instanceUrl}\n`,
      );
      return 0;
    }
    return setupPlayer(instanceUrl, cwd, io, runner);
  }
  return 0;
}

async function runUpgrade(
  flags: Awaited<ReturnType<typeof parseFlags>>,
  io: IO,
  runner: Runner,
): Promise<number> {
  if (flags.target === "existing") {
    io.output.write(
      "--target existing points at an instance someone else runs — nothing to upgrade here.\n",
    );
    return 0;
  }

  const resolved = await resolveInstance(
    {
      target: flags.target,
      workerName: flags.workerName,
      d1Name: flags.d1Name,
      r2Bucket: flags.r2Bucket,
      domain: flags.domain,
    },
    runner,
  );

  if (!resolved.ok) {
    io.output.write(`${resolved.reason}\n`);
    for (const c of resolved.candidates) io.output.write(`  - ${c}\n`);
    return 1;
  }

  const inst = resolved.instance;
  const label =
    inst.target === "docker"
      ? `docker container "${inst.containerName}" (volume ${inst.volume})`
      : `cloudflare worker "${inst.workerName}"`;
  io.output.write(`Found: ${label}\n`);

  const stagingDir = await runner.mkdtemp("demo-locker-upgrade-");
  try {
    let plan;
    try {
      plan = buildUpgradePlan(inst, stagingDir);
    } catch (err) {
      io.output.write(`${err instanceof Error ? err.message : err}\n`);
      return 1;
    }
    if (flags.dryRun) {
      io.output.write(renderPlan(plan));
      return 0;
    }
    // Confirm before writing to something that already exists and holds data.
    // Prompting here rather than inside executePlan keeps the executor free of
    // interaction — it is used by the install path too.
    if (!flags.yes) {
      io.output.write(renderPlan(plan));
      const answer = await ask(io, "Upgrade this instance? (y/N)", "N");
      if (!/^y(es)?$/i.test(answer)) {
        io.output.write("Cancelled — nothing was changed.\n");
        return 0;
      }
    }
    return await executePlan(plan, null, io, runner);
  } finally {
    await runner.rmDir(stagingDir);
  }
}
