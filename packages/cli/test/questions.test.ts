import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags, detectContext, collectAnswers } from "../src/questions.js";
import { fakeIO, waitForOutput } from "./helpers.js";

describe("parseFlags", () => {
  it("parses all long flags", () => {
    const f = parseFlags([
      "--mode", "instance", "--target", "docker", "--storage", "s3",
      "--port", "4000", "--volume", "bandstuff",
      "--s3-endpoint", "https://x.r2.cloudflarestorage.com",
      "--s3-bucket", "demos", "--s3-access-key", "AK", "--s3-secret-key", "SK",
      "--email", "dl@fldl.space", "--password", "hunter22",
      "--yes", "--dry-run",
    ]);
    expect(f.mode).toBe("instance");
    expect(f.port).toBe("4000");
    expect(f.yes).toBe(true);
    expect(f.dryRun).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(() => parseFlags(["--mode", "banana"])).toThrow(/mode/);
  });
});

describe("detectContext", () => {
  it("web-project when package.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    writeFileSync(join(dir, "package.json"), "{}");
    expect(detectContext(dir)).toBe("web-project");
  });
  it("empty otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    expect(detectContext(dir)).toBe("empty");
  });
});

describe("collectAnswers", () => {
  it("fully non-interactive with flags + --yes (docker/local)", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--storage", "local", "--yes"]);
    const a = await collectAnswers(flags, io, "empty");
    expect(a).toMatchObject({
      mode: "instance", target: "docker", storage: "local",
      port: 3001, volume: "demolocker", s3: null, signup: null, url: null,
    });
  });

  it("player mode with --url skips instance questions", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "player", "--url", "https://demos.fldl.space", "--yes"]);
    const a = await collectAnswers(flags, io, "web-project");
    expect(a.target).toBeNull();
    expect(a.storage).toBeNull();
    expect(a.url).toBe("https://demos.fldl.space");
  });

  it("defaults mode by context: web-project → both, empty → instance", async () => {
    const { io } = fakeIO();
    const a1 = await collectAnswers(parseFlags(["--yes", "--target", "docker"]), io, "web-project");
    expect(a1.mode).toBe("both");
    const a2 = await collectAnswers(parseFlags(["--yes"]), io, "empty");
    expect(a2.mode).toBe("instance");
  });

  it("s3 storage requires the s3 flags in --yes mode", async () => {
    const { io } = fakeIO();
    const flags = parseFlags(["--mode", "instance", "--target", "docker", "--storage", "s3", "--yes"]);
    await expect(collectAnswers(flags, io, "empty")).rejects.toThrow(/--s3-endpoint/);
  });

  it("interactive path walks the tree", async () => {
    const { io, write, read } = fakeIO();
    const flags = parseFlags([]);
    const p = collectAnswers(flags, io, "empty");

    // Cross-prompt type-ahead is unsupported: ask()/select() each open and
    // close their own readline interface, and select() consumes lines via
    // async iteration internally. A line written for a later prompt while an
    // earlier prompt's interface is still open can be swallowed and lost
    // when that interface closes. Real humans type after seeing each prompt;
    // scripted callers use flags. So here we wait for each prompt's text to
    // actually appear in the output before writing its answer, rather than
    // writing all answers synchronously up front.
    await waitForOutput(read, "What do you need?");
    write("1\n"); // mode: instance
    await waitForOutput(read, "Where will it run?");
    write("1\n"); // target: docker
    await waitForOutput(read, "Where should audio files live?");
    write("1\n"); // storage: local
    await waitForOutput(read, "Host port?");
    write("\n"); // port: default 3001
    await waitForOutput(read, "Docker volume name");
    write("\n"); // volume: default demolocker
    await waitForOutput(read, "Create the first account now?");
    write("\n"); // email: empty → skip signup

    const a = await p;
    expect(a.mode).toBe("instance");
    expect(a.signup).toBeNull();
  });
});
