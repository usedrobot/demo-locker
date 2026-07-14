import { createRequire } from "node:module";

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

export async function main(argv: string[], io: IO): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.output.write(USAGE);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    const require = createRequire(import.meta.url);
    io.output.write(require("../package.json").version + "\n");
    return 0;
  }
  io.output.write(USAGE);
  return 0;
}
