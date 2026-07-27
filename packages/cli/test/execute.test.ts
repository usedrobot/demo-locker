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
    execCapture: vi.fn(async () => ({ code: 0, stdout: "" })),
    writeFile: vi.fn(async (path: string) => {
      calls.push(`write ${path}`);
    }),
    copyDir: vi.fn(async (from: string, to: string) => {
      calls.push(`copy ${from} -> ${to}`);
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

  it("survives a rejected signup fetch (network error) and still exits 0", async () => {
    const { io, read } = fakeIO();
    const fetchFn = vi.fn(async (url: any) => {
      if (String(url).endsWith("/auth/signup")) {
        throw new Error("ECONNRESET");
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = fakeRunner({ fetchFn });
    const code = await executePlan(dockerPlan, { email: "dl@fldl.space", password: "pw" }, io, r);
    expect(code).toBe(0);
    expect(read()).toContain("sign up manually");
    expect(read()).toContain("http://localhost:3001");
  });

  it("passes an AbortSignal to the health check fetch", async () => {
    const { io } = fakeIO();
    const seen: any[] = [];
    const fetchFn = vi.fn(async (_url: any, init?: any) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = fakeRunner({ fetchFn });
    await executePlan(dockerPlan, null, io, r);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeDefined();
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
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

  it("hints at wrangler login when the whoami step fails", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({ exec: vi.fn(async () => 1) });
    const code = await executePlan(
      {
        steps: [{ kind: "run", title: "Check Cloudflare login", cmd: "wrangler", args: ["whoami"] }],
        healthUrl: null,
        appUrl: null,
      },
      null, io, r,
    );
    expect(code).toBe(1);
    expect(read()).toContain("wrangler login");
  });

  it("hints that the bucket may already exist when r2 bucket create fails", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({ exec: vi.fn(async () => 1) });
    const code = await executePlan(
      {
        steps: [{ kind: "run", title: "Create R2 bucket", cmd: "wrangler", args: ["r2", "bucket", "create", "demo-locker-demos"] }],
        healthUrl: null,
        appUrl: null,
      },
      null, io, r,
    );
    expect(code).toBe(1);
    expect(read()).toContain("--r2-bucket");
    expect(read()).toContain("wrangler r2 bucket delete demo-locker-demos");
  });

  it("tells the user where to look when a plan with no known appUrl succeeds", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner();
    const code = await executePlan(
      {
        steps: [{ kind: "run", title: "Deploy", cmd: "wrangler", args: ["deploy"] }],
        healthUrl: null,
        appUrl: null,
      },
      null, io, r,
    );
    expect(code).toBe(0);
    expect(read()).toContain("workers.dev");
    expect(read()).toContain("first account in wins");
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

describe("copy step", () => {
  const copyPlan: DeployPlan = {
    steps: [
      { kind: "copy", title: "Unpack Demo Locker", from: "/pkg/assets", to: "demo-locker" },
      { kind: "write", title: "Write wrangler.jsonc", path: "demo-locker/wrangler.jsonc", contents: "{}" },
    ],
    healthUrl: null,
    appUrl: null,
  };

  it("unpacks the assets before writing the config into that directory", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner();
    const code = await executePlan(copyPlan, null, io, r);
    expect(code).toBe(0);
    expect(r.calls).toEqual([
      "copy /pkg/assets -> demo-locker",
      "write demo-locker/wrangler.jsonc",
    ]);
    expect(read()).toContain("Unpack Demo Locker");
  });

  it("stops with a hint when the packaged assets are missing", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({
      copyDir: async () => {
        throw new Error("ENOENT: no such file or directory, lstat '/pkg/assets'");
      },
    });
    const code = await executePlan(copyPlan, null, io, r);
    expect(code).toBe(1);
    expect(read()).toContain("ENOENT");
    expect(read()).toContain("build:assets");
    expect(read()).not.toContain("already exists as a file");
    // The config must not be written into a directory that was never unpacked.
    expect(r.calls).not.toContain("write demo-locker/wrangler.jsonc");
  });

  it("says so when the destination already exists as a file", async () => {
    const { io, read } = fakeIO();
    const r = fakeRunner({
      copyDir: async () => {
        // Verbatim shape of what node:fs/promises cp() rejects with when the
        // destination exists as a file (checked against Node on 2026-07-27).
        const err: NodeJS.ErrnoException = new Error(
          "Cannot overwrite non-directory with directory: cp returned EISDIR" +
          " (cannot overwrite non-directory demo-locker with directory /pkg/assets) demo-locker",
        );
        err.code = "ERR_FS_CP_DIR_TO_NON_DIR";
        throw err;
      },
    });
    const code = await executePlan(copyPlan, null, io, r);
    expect(code).toBe(1);
    expect(read()).toContain('"demo-locker" already exists as a file');
    expect(read()).not.toContain("build:assets");
  });
});

describe("run-capture", () => {
  it("captures a uuid from stdout and substitutes it into a later write", async () => {
    const { io, read } = fakeIO();
    const written: Record<string, string> = {};
    const runner: Runner = {
      exec: async () => 0,
      execCapture: async () => ({
        code: 0,
        stdout: 'database_id = "11111111-2222-3333-4444-555555555555"',
      }),
      writeFile: async (p, c) => { written[p] = c; },
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      sleep: async () => {},
      copyDir: async () => {},
    };

    const code = await executePlan(
      {
        steps: [
          { kind: "run-capture", title: "Create D1", cmd: "wrangler", args: ["d1", "create", "db"], capture: "DATABASE_ID" },
          { kind: "write", title: "Write config", path: "wrangler.jsonc", contents: '{"database_id":"__DATABASE_ID__"}' },
        ],
        healthUrl: null,
        appUrl: null,
      },
      null, io, runner,
    );

    expect(code).toBe(0);
    expect(written["wrangler.jsonc"]).toBe('{"database_id":"11111111-2222-3333-4444-555555555555"}');
    expect(read()).toContain("Create D1");
  });

  it("prefers the database_id field over an unrelated uuid earlier in stdout", async () => {
    const { io } = fakeIO();
    const written: Record<string, string> = {};
    // Shape of real `wrangler d1 create` output, with a banner that happens to
    // carry an account tag ahead of the JSON block.
    const stdout = [
      "Account ID: 1b4e28ba-2fa1-11d2-883f-0016d3cca427",
      "✅ Successfully created DB 'demo-locker-db' in region ENAM",
      "Created your new D1 database.",
      "{",
      '  "d1_databases": [',
      "    {",
      '      "binding": "demo_locker_db",',
      '      "database_name": "demo-locker-db",',
      '      "database_id": "0ea573b2-861c-482c-a9c7-de5335d29fa0"',
      "    }",
      "  ]",
      "}",
    ].join("\n");
    const runner: Runner = {
      exec: async () => 0,
      execCapture: async () => ({ code: 0, stdout }),
      writeFile: async (p, c) => { written[p] = c; },
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      sleep: async () => {},
      copyDir: async () => {},
    };

    const code = await executePlan(
      {
        steps: [
          { kind: "run-capture", title: "Create D1", cmd: "wrangler", args: ["d1", "create", "demo-locker-db"], capture: "DATABASE_ID" },
          { kind: "write", title: "Write config", path: "wrangler.jsonc", contents: "__DATABASE_ID__" },
        ],
        healthUrl: null,
        appUrl: null,
      },
      null, io, runner,
    );

    expect(code).toBe(0);
    expect(written["wrangler.jsonc"]).toBe("0ea573b2-861c-482c-a9c7-de5335d29fa0");
  });

  it("hints that the database may already exist when d1 create fails", async () => {
    const { io, read } = fakeIO();
    const runner: Runner = {
      exec: async () => 0,
      execCapture: async () => ({ code: 1, stdout: "" }),
      writeFile: async () => {},
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      sleep: async () => {},
      copyDir: async () => {},
    };
    const code = await executePlan(
      {
        steps: [
          { kind: "run-capture", title: "Create D1", cmd: "wrangler", args: ["d1", "create", "demo-locker-db"], capture: "DATABASE_ID" },
        ],
        healthUrl: null,
        appUrl: null,
      },
      null, io, runner,
    );
    expect(code).toBe(1);
    expect(read()).toContain("--d1-name");
    expect(read()).toContain("wrangler d1 delete demo-locker-db");
  });

  it("fails with the raw output when no uuid is present", async () => {
    const { io, read } = fakeIO();
    const runner: Runner = {
      exec: async () => 0,
      execCapture: async () => ({ code: 0, stdout: "something unexpected" }),
      writeFile: async () => {},
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      sleep: async () => {},
      copyDir: async () => {},
    };

    const code = await executePlan(
      {
        steps: [
          { kind: "run-capture", title: "Create D1", cmd: "wrangler", args: [], capture: "DATABASE_ID" },
        ],
        healthUrl: null,
        appUrl: null,
      },
      null, io, runner,
    );

    expect(code).toBe(1);
    expect(read()).toContain("something unexpected");
  });
});
