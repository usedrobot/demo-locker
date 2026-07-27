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
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {} }, cwd: dir },
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
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn, sleep: async () => {} }, cwd: dir },
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
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {} }, cwd: dir },
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
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {} }, cwd: dir },
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
    const writeFile = vi.fn(async () => {});
    const code = await main(
      ["--mode", "both", "--target", "cloudflare", "--yes"],
      io,
      { runner: { exec, execCapture, writeFile, fetchFn: fetch, sleep: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(read()).toContain("--mode player --url");
  });

  it("player-only-with-url + --dry-run never execs and exits 0", async () => {
    const { io, read } = fakeIO();
    const dir = mkdtempSync(join(tmpdir(), "dle-"));
    const exec = vi.fn(async () => 0);
    const code = await main(
      ["--mode", "player", "--url", "https://demos.fldl.space", "--yes", "--dry-run"],
      io,
      { runner: { exec, execCapture: async () => ({ code: 0, stdout: "" }), writeFile: async () => {}, fetchFn: fetch, sleep: async () => {} }, cwd: dir },
    );
    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(read()).toContain("dry-run");
  });
});
