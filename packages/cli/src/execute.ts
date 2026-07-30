import { spawn } from "node:child_process";
import { cp, writeFile as fsWriteFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { IO } from "./main.js";
import type { DeployPlan } from "./plan.js";

export interface Runner {
  exec(cmd: string, args: string[]): Promise<number>;
  execCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
  writeFile(path: string, contents: string): Promise<void>;
  copyDir(from: string, to: string): Promise<void>;
  fetchFn: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export function defaultRunner(_io: IO): Runner {
  return {
    exec: (cmd, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: "inherit" });
        child.on("error", (err) =>
          reject(
            new Error(`could not run "${cmd}" — is it installed and on PATH? (${err.message})`),
          ),
        );
        child.on("close", (code) => resolve(code ?? 1));
      }),
    execCapture: (cmd, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "inherit"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          const text = chunk.toString();
          stdout += text;
          process.stdout.write(text);
        });
        child.on("error", (err) =>
          reject(
            new Error(`could not run "${cmd}" — is it installed and on PATH? (${err.message})`),
          ),
        );
        child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
      }),
    writeFile: (path, contents) => fsWriteFile(path, contents),
    copyDir: (from, to) => cp(from, to, { recursive: true }),
    fetchFn: fetch,
    sleep: (ms) => delay(ms),
  };
}

async function waitHealthy(url: string, runner: Runner): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await runner.fetchFn(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await runner.sleep(1000);
  }
  return false;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Pull the D1 database id out of `wrangler d1 create` output. Prefers an
 * anchored match on the `database_id` field so an unrelated UUID elsewhere in
 * the output (an account tag in a banner, say) can't bind the Worker to the
 * wrong database. Falls back to the first UUID-shaped substring.
 */
function extractDatabaseId(stdout: string): string | null {
  const anchored = new RegExp(`database_id"?\\s*[:=]\\s*"?(${UUID})`, "i").exec(stdout);
  if (anchored) return anchored[1];
  const loose = new RegExp(UUID, "i").exec(stdout);
  return loose ? loose[0] : null;
}

/**
 * A recovery hint for a step that just failed, or null. These cover the failure
 * modes a first run actually hits: not logged in, and re-running after R2
 * billing blocked the first attempt part-way through provisioning.
 */
function failureHint(cmd: string, args: string[]): string | null {
  if (cmd === "docker" && args[0] === "run") {
    const nameIdx = args.indexOf("--name");
    const name = nameIdx !== -1 ? args[nameIdx + 1] : "<name>";
    return `a container named like your volume may already exist — try: docker rm -f ${name}`;
  }
  if (cmd !== "wrangler") return null;
  if (args[0] === "whoami") {
    return "not logged in? run: wrangler login — then re-run this command";
  }
  if (args[0] === "d1" && args[1] === "create") {
    const name = args[2] ?? "<name>";
    return `if "${name}" already exists from an earlier run, either re-run with --d1-name <existing-name>, or delete it first: wrangler d1 delete ${name}`;
  }
  if (args[0] === "r2" && args[1] === "bucket" && args[2] === "create") {
    const name = args[3] ?? "<name>";
    return `R2 needs billing enabled on the account. If "${name}" already exists from an earlier run, either re-run with --r2-bucket <existing-name>, or delete it first: wrangler r2 bucket delete ${name}`;
  }
  return null;
}

export async function executePlan(
  plan: DeployPlan,
  signup: { email: string; password: string } | null,
  io: IO,
  runner: Runner,
): Promise<number> {
  const captured = new Map<string, string>();
  for (const step of plan.steps) {
    if (step.kind === "note") {
      io.output.write(`${step.text}\n`);
      continue;
    }
    io.output.write(`→ ${step.title}\n`);
    if (step.kind === "run-capture") {
      const { code, stdout } = await runner.execCapture(step.cmd, step.args);
      if (code !== 0) {
        io.output.write(`✗ step failed (${step.cmd} exited ${code}): ${step.title}\n`);
        const hint = failureHint(step.cmd, step.args);
        if (hint) io.output.write(`  hint: ${hint}\n`);
        return 1;
      }
      const id = extractDatabaseId(stdout);
      if (!id) {
        io.output.write(
          `✗ could not read ${step.capture} from ${step.cmd} output:\n${stdout}\n`,
        );
        return 1;
      }
      captured.set(step.capture, id);
      continue;
    }
    if (step.kind === "copy") {
      try {
        await runner.copyDir(step.from, step.to);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.output.write(`✗ step failed: ${step.title}\n`);
        io.output.write(`  ${message}\n`);
        // Match on the error code, not the prose: Node's cp() rejects a
        // dir-onto-file collision with ERR_FS_CP_DIR_TO_NON_DIR and the message
        // "Cannot overwrite non-directory with directory ... EISDIR".
        const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "";
        const hint = code === "ERR_FS_CP_DIR_TO_NON_DIR" ||
          /EISDIR|ENOTDIR|non-directory/i.test(message)
          ? `hint: "${step.to}" already exists as a file — move or delete it, then re-run.`
          : `hint: could not read the packaged deployable at ${step.from}, or could not write` +
            ` to "${step.to}". If this install of demo-locker is missing its assets, re-run` +
            ` with npx demo-locker@latest; from a source checkout, build them first:` +
            ` npm run build:assets -w packages/cli`;
        io.output.write(`  ${hint}\n`);
        return 1;
      }
      continue;
    }
    if (step.kind === "write") {
      let contents = step.contents;
      for (const [key, value] of captured) {
        contents = contents.split(`__${key}__`).join(value);
      }
      await runner.writeFile(step.path, contents);
      continue;
    }
    const code = await runner.exec(step.cmd, step.args);
    if (code !== 0) {
      io.output.write(`✗ step failed (${step.cmd} exited ${code}): ${step.title}\n`);
      const hint = failureHint(step.cmd, step.args);
      if (hint) io.output.write(`  hint: ${hint}\n`);
      return 1;
    }
  }

  if (plan.healthUrl) {
    io.output.write(`→ waiting for ${plan.healthUrl}\n`);
    if (!(await waitHealthy(plan.healthUrl, runner))) {
      io.output.write(`✗ server never became healthy at ${plan.healthUrl}\n`);
      if (plan.appUrl?.includes("localhost")) io.output.write(`  check: docker logs\n`);
      return 1;
    }
    io.output.write(`✓ healthy\n`);
  }

  if (signup && plan.appUrl) {
    try {
      const res = await runner.fetchFn(`${plan.appUrl.replace(/\/$/, "")}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signup),
      });
      if (res.ok) io.output.write(`✓ Account created for ${signup.email}\n`);
      else if (res.status === 403) {
        // Registration closes once an instance has an owner, so this is the
        // expected answer when the target already has an account — a redeploy
        // or an upgrade, not a failure. Telling someone to "sign up manually"
        // here would send them at a door that is supposed to be locked.
        io.output.write(
          `• This instance already has an account — signup is closed, sign in with it.\n` +
          `  (Set ALLOW_SIGNUP=true on the deployment if you want open registration.)\n`
        );
      } else io.output.write(`✗ signup failed (${res.status}) — open the app and sign up manually\n`);
    } catch {
      io.output.write(`✗ signup failed (network error) — open the app and sign up manually\n`);
    }
  }

  if (plan.appUrl) {
    io.output.write(`\nYour Demo Locker: ${plan.appUrl}\n`);
    if (!signup) io.output.write(`Open it and sign up — the first account in wins.\n`);
  } else if (plan.steps.length > 0) {
    // Deploy succeeded but the URL isn't knowable ahead of time — the cloudflare
    // target with no custom domain. Say so rather than exiting silently.
    io.output.write(
      `\nDeploy finished. Your Demo Locker is at the URL printed above by the deploy step` +
      ` (it ends in .workers.dev).\n` +
      `Open it and sign up — the first account in wins.\n`,
    );
  }
  return 0;
}
