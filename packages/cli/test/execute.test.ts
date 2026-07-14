import { describe, it, expect, vi } from "vitest";
import { executePlan } from "../src/execute.js";
import type { Runner } from "../src/execute.js";
import type { DeployPlan } from "../src/plan.js";
import { fakeIO } from "./helpers.js";

function fakeRunner(overrides: Partial<Runner> = {}): Runner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: vi.fn(async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return 0;
    }),
    writeFile: vi.fn(async (path: string) => {
      calls.push(`write ${path}`);
    }),
    fetchFn: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    sleep: async () => {},
    ...overrides,
  };
}

const dockerPlan: DeployPlan = {
  steps: [
    { kind: "run", title: "Create data volume", cmd: "docker", args: ["volume", "create", "demolocker"] },
    { kind: "run", title: "Start", cmd: "docker", args: ["run", "-d"] },
  ],
  healthUrl: "http://localhost:3001/health",
  appUrl: "http://localhost:3001",
};

describe("executePlan", () => {
  it("runs steps in order, polls health, prints URL", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner();
    const code = await executePlan(dockerPlan, null, io, r);
    expect(code).toBe(0);
    expect(r.calls).toEqual(["docker volume create demolocker", "docker run -d"]);
    expect(read()).toContain("http://localhost:3001");
  });

  it("stops on nonzero exit and reports the failed step", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({ exec: vi.fn(async () => 1) });
    const code = await executePlan(dockerPlan, null, io, r);
    expect(code).toBe(1);
    expect(read()).toContain("failed");
  });

  it("creates the first account when signup is given", async () => {
    const { io, read } = fakeIO();
    const fetchFn = vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith("/auth/signup")) {
        expect(JSON.parse(init.body)).toEqual({ email: "dl@fldl.space", password: "pw" });
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = fakeRunner({ fetchFn });
    const code = await executePlan(dockerPlan, { email: "dl@fldl.space", password: "pw" }, io, r);
    expect(code).toBe(0);
    expect(read()).toContain("Account created");
  });

  it("hints at docker rm -f when a docker run step fails", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({ exec: vi.fn(async () => 1) });
    const runPlan: DeployPlan = {
      steps: [
        { kind: "run", title: "Start", cmd: "docker", args: ["run", "-d", "--name", "demolocker"] },
      ],
      healthUrl: null,
      appUrl: null,
    };
    const code = await executePlan(runPlan, null, io, r);
    expect(code).toBe(1);
    expect(read()).toContain("docker rm -f demolocker");
  });

  it("gives up on health after 60 attempts", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({
      fetchFn: vi.fn(async () => {
        throw new Error("conn refused");
      }) as unknown as typeof fetch,
    });
    const code = await executePlan(dockerPlan, null, io, r);
    expect(code).toBe(1);
    expect(read()).toContain("never became healthy");
  });
});
