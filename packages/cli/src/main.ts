import { createRequire } from "node:module";
import { parseFlags, detectContext, collectAnswers } from "./questions.js";
import { buildPlan, renderPlan } from "./plan.js";
import { executePlan, defaultRunner } from "./execute.js";
import type { Runner } from "./execute.js";
import { setupPlayer } from "./embed.js";

export interface IO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const USAGE = `Usage: npx demo-locker [options]

Sets up a Demo Locker — self-hosted music streaming for demos and mixes.

Options:
  --mode <instance|player|both>   what to set up
  --target <docker|fly|railway|existing>  where the instance runs
  --storage <local|s3>            where audio files live
  --port <n>                      host port for docker target (default 3001)
  --volume <name>                 docker volume name (default demolocker)
  --url <https://...>             existing instance URL (player/existing)
  --email <addr> --password <pw>  create the first account after boot
  --s3-endpoint --s3-bucket --s3-access-key --s3-secret-key --s3-region
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

  if (wantsInstance || (wantsPlayer && answers.target)) {
    const plan = buildPlan(answers);
    if (answers.dryRun) {
      io.output.write(renderPlan(plan));
      return 0;
    }
    const code = await executePlan(plan, answers.signup, io, runner);
    if (code !== 0) return code;
    instanceUrl = plan.appUrl ?? instanceUrl;
  }

  if (wantsPlayer) {
    if (!instanceUrl) {
      io.output.write("No instance URL known — pass --url or deploy an instance first.\n");
      return 1;
    }
    return setupPlayer(instanceUrl, cwd, io, runner);
  }
  return 0;
}
