import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";
import { fakeIO } from "./helpers.js";

describe("main", () => {
  it("--help prints usage and exits 0", async () => {
    const { io, read } = fakeIO();
    const code = await main(["--help"], io);
    expect(code).toBe(0);
    expect(read()).toContain("Usage: npx demo-locker");
    expect(read()).toContain("--mode");
  });

  it("--help documents every flag parseFlags accepts", async () => {
    const { io, read } = fakeIO();
    await main(["--help"], io);
    const usage = read();
    // Guards against a flag being added to parseFlags but never surfaced in
    // --help. Keep this list in sync with the options map in questions.ts.
    const flags = [
      "--mode", "--target", "--storage", "--port", "--volume", "--url",
      "--email", "--password", "--s3-endpoint", "--s3-bucket", "--s3-access-key",
      "--s3-secret-key", "--s3-region", "--worker-name", "--d1-name",
      "--r2-bucket", "--domain", "--upgrade", "--yes", "--dry-run", "--help", "--version",
    ];
    for (const flag of flags) expect(usage, `${flag} missing from --help`).toContain(flag);
  });

  it("--help lists the real targets and no retired ones", async () => {
    const { io, read } = fakeIO();
    await main(["--help"], io);
    expect(read()).toContain("--target <cloudflare|docker|existing>");
    expect(read()).not.toMatch(/\bfly\b|railway/i);
  });

  it("--version prints the package version", async () => {
    const { io, read } = fakeIO();
    const code = await main(["--version"], io);
    expect(code).toBe(0);
    expect(read().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("main end-to-end (non-interactive)", () => {
  it("--dry-run prints the docker plan without executing", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const code = await main(
      ["--mode", "instance", "--target", "docker", "--storage", "local", "--yes", "--dry-run"],
      io,
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(read()).toContain("docker run -d");
    expect(exec).not.toHaveBeenCalled();
  });

  it("full instance run executes plan and prints URL", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const code = await main(
      ["--mode", "instance", "--target", "docker", "--yes"],
      io,
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2); // volume create + docker run
    expect(read()).toContain("Your Demo Locker: http://localhost:3001");
  });

  it("player mode with --url skips deploy, emits snippet", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const code = await main(
      ["--mode", "player", "--url", "https://demos.fldl.space", "--yes"],
      io,
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(read()).toContain("https://demos.fldl.space/embed.js");
  });

  it("--url combined with a provisioning target is caught and exits 1", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const code = await main(
      ["--mode", "instance", "--target", "docker", "--url", "https://x", "--yes"],
      io,
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(1);
    expect(read()).toContain("--url");
    expect(exec).not.toHaveBeenCalled();
  });

  it("both-mode with a null-appUrl target (cloudflare, no custom domain) prints guidance and exits 0 after a successful deploy", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const execCapture = vi.fn(async () => ({ code: 0, stdout: "database_id = \"1b4e28ba-2fa1-11d2-883f-0016d3cca427\"\n" }));
    const writeFile = vi.fn(async (_path: string, _contents: string) => {});
    const code = await main(
      ["--mode", "both", "--target", "cloudflare", "--yes"],
      io,
      { runner: { exec, execCapture, writeFile, fetchFn: fetch, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(read()).toContain("--mode player --url");
    expect(writeFile).toHaveBeenCalledWith(
      "demo-locker/wrangler.jsonc",
      expect.stringContaining("1b4e28ba-2fa1-11d2-883f-0016d3cca427"),
    );
    expect(writeFile.mock.calls[0][1]).not.toContain("__DATABASE_ID__");
  });

  it("instance-only cloudflare with no domain deploys, then says where to find the app", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const execCapture = vi.fn(async () => ({
      code: 0,
      stdout: '"database_id": "0ea573b2-861c-482c-a9c7-de5335d29fa0"\n',
    }));
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const code = await main(
      ["--mode", "instance", "--target", "cloudflare", "--yes"],
      io,
      { runner: { exec, execCapture, writeFile: async () => {}, fetchFn, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    // There is no knowable URL yet, so no health poll and no signup POST — but
    // the run must not end silently on "→ Deploy" either.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(read()).toContain("workers.dev");
    expect(read()).toContain("first account in wins");
  });

  it("cloudflare with a domain polls health and prints the app URL", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const execCapture = vi.fn(async () => ({
      code: 0,
      stdout: '"database_id": "0ea573b2-861c-482c-a9c7-de5335d29fa0"\n',
    }));
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const code = await main(
      ["--mode", "instance", "--target", "cloudflare", "--domain", "demos.example.com", "--yes"],
      io,
      { runner: { exec, execCapture, writeFile: async () => {}, fetchFn, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(read()).toContain("Your Demo Locker: https://demos.example.com");
  });

  it("player-only-with-url + --dry-run never execs and exits 0", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const code = await main(
      ["--mode", "player", "--url", "https://demos.fldl.space", "--yes", "--dry-run"],
      io,
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {}, copyDir: async () => {}, mkdtemp: async (prefix: string) => `/tmp/${prefix}fake`, rmDir: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(read()).toContain("dry-run");
  });
});
