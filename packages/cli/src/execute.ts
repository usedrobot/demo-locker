import { spawn } from "node:child_process";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { IO } from "./main.js";
import type { DeployPlan } from "./plan.js";

export interface Runner {
  exec(cmd: string, args: string[]): Promise<number>;
  execCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
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
        return 1;
      }
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(stdout);
      if (!uuid) {
        io.output.write(
          `✗ could not read ${step.capture} from ${step.cmd} output:\n${stdout}\n`,
        );
        return 1;
      }
      captured.set(step.capture, uuid[0]);
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
