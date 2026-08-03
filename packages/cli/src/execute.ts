import { spawn } from "node:child_process";
import { cp, writeFile as fsWriteFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { IO } from "./main.js";
import type { DeployPlan } from "./plan.js";

export interface Runner {
  exec(cmd: string, args: string[]): Promise<number>;
  /**
   * `quiet` suppresses the live echo to this process's stdout. Only for
   * lookups whose output is machinery, not information — e.g. probing whether
   * an image tag exists, where `docker manifest inspect` would otherwise dump
   * a page of JSON into the middle of an upgrade.
   */
  execCapture(
    cmd: string,
    args: string[],
    opts?: { quiet?: boolean },
  ): Promise<{ code: number; stdout: string }>;
  writeFile(path: string, contents: string): Promise<void>;
  copyDir(from: string, to: string): Promise<void>;
  fetchFn: typeof fetch;
  sleep(ms: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rmDir(path: string): Promise<void>;
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
    execCapture: (cmd, args, opts) =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["inherit", "pipe", opts?.quiet ? "ignore" : "inherit"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          const text = chunk.toString();
          stdout += text;
          if (!opts?.quiet) process.stdout.write(text);
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
    mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    rmDir: (path) => rm(path, { recursive: true, force: true }),
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
    return (
      `a container named "${name}" may already exist — try: docker rm -f ${name}\n` +
      `        if this was an upgrade, the previous container is still here as "${name}-preupgrade" — ` +
      `put it back with: docker rename ${name}-preupgrade ${name} && docker start ${name}`
    );
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
    if (step.kind === "run-assert") {
      const { code, stdout } = await runner.execCapture(step.cmd, step.args);
      if (code !== 0) {
        io.output.write(`✗ step failed (${step.cmd} exited ${code}): ${step.title}\n`);
        const hint = failureHint(step.cmd, step.args);
        if (hint) io.output.write(`  hint: ${hint}\n`);
        return 1;
      }
      // Fails closed: output that doesn't match stops the plan. The point of
      // this step kind is that a zero exit code is not proof the work happened.
      if (!new RegExp(step.pattern).test(stdout)) {
        io.output.write(`✗ ${step.failure}\n`);
        return 1;
      }
      continue;
    }
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

  // afterHealthySteps live inside this block on purpose: with no health check
  // there is no "proven" to wait for, so there is nothing that would make the
  // destructive cleanup safe to run. Every plan that sets them sets healthUrl.
  if (plan.healthUrl) {
    io.output.write(`→ waiting for ${plan.healthUrl}\n`);
    if (!(await waitHealthy(plan.healthUrl, runner))) {
      io.output.write(`✗ server never became healthy at ${plan.healthUrl}\n`);
      if (plan.appUrl?.includes("localhost")) io.output.write(`  check: docker logs\n`);
      // The whole reason afterHealthySteps exists is that its work is
      // destructive and only safe once the new deployment is proven. Say what
      // was left behind so it can be used to roll back, not hunted for.
      if (plan.afterHealthySteps?.length) {
        io.output.write(
          `  the previous version was left in place and NOT removed — these cleanup steps were skipped:\n`,
        );
        for (const s of plan.afterHealthySteps) io.output.write(`    ${s.kind === "note" ? s.text : s.title}\n`);
      }
      // Knowing the old version survived is only half of it — say how to get
      // back to it, for the user who never opens the docs.
      if (plan.rollbackHint) {
        io.output.write(`  to roll back to the previous version:\n    ${plan.rollbackHint}\n`);
      }
      return 1;
    }
    io.output.write(`✓ healthy\n`);

    for (const step of plan.afterHealthySteps ?? []) {
      if (step.kind === "note") {
        io.output.write(`${step.text}\n`);
        continue;
      }
      if (step.kind !== "run") {
        // Nothing else is needed here yet, and quietly skipping a step would
        // be worse than saying so.
        io.output.write(`✗ internal error: unsupported post-health step kind "${step.kind}"\n`);
        return 1;
      }
      io.output.write(`→ ${step.title}\n`);
      const code = await runner.exec(step.cmd, step.args);
      if (code !== 0) {
        // The upgrade itself succeeded — the instance is up and serving. Only
        // cleanup failed, so report it without failing the run.
        io.output.write(`• could not finish: ${step.title} (${step.cmd} exited ${code}) — clean it up by hand\n`);
      }
    }
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
