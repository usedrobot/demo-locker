import { spawn } from "node:child_process";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { IO } from "./main.js";
import type { DeployPlan } from "./plan.js";

export interface Runner {
  exec(cmd: string, args: string[]): Promise<number>;
  writeFile(path: string, contents: string): Promise<void>;
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
    writeFile: (path, contents) => fsWriteFile(path, contents),
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

export async function executePlan(
  plan: DeployPlan,
  signup: { email: string; password: string } | null,
  io: IO,
  runner: Runner,
): Promise<number> {
  for (const step of plan.steps) {
    if (step.kind === "note") {
      io.output.write(`${step.text}\n`);
      continue;
    }
    io.output.write(`→ ${step.title}\n`);
    if (step.kind === "write") {
      await runner.writeFile(step.path, step.contents);
      continue;
    }
    const code = await runner.exec(step.cmd, step.args);
    if (code !== 0) {
      io.output.write(`✗ step failed (${step.cmd} exited ${code}): ${step.title}\n`);
      if (step.cmd === "docker" && step.args[0] === "run") {
        const nameIdx = step.args.indexOf("--name");
        const name = nameIdx !== -1 ? step.args[nameIdx + 1] : "<name>";
        io.output.write(
          `  hint: a container named like your volume may already exist — try: docker rm -f ${name}\n`,
        );
      }
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
      else io.output.write(`✗ signup failed (${res.status}) — open the app and sign up manually\n`);
    } catch {
      io.output.write(`✗ signup failed (network error) — open the app and sign up manually\n`);
    }
  }

  if (plan.appUrl) {
    io.output.write(`\nYour Demo Locker: ${plan.appUrl}\n`);
    if (!signup) io.output.write(`Open it and sign up — the first account in wins.\n`);
  }
  return 0;
}
