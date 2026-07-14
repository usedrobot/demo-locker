import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedSnippets, setupPlayer } from "../src/embed.js";
import { fakeIO } from "./helpers.js";

describe("embedSnippets", () => {
  it("script tag loads embed.js from the instance, no instance attr needed", () => {
    const s = embedSnippets("https://demos.fldl.space");
    expect(s.scriptTag).toContain('<script src="https://demos.fldl.space/embed.js"></script>');
    expect(s.scriptTag).toContain('<demo-locker-player playlist="YOUR_PLAYLIST_ID">');
  });
  it("npm variant includes the required instance attribute", () => {
    const s = embedSnippets("https://demos.fldl.space");
    expect(s.npmModule).toContain('import "@demo-locker/player"');
    expect(s.npmModule).toContain('instance="https://demos.fldl.space"');
  });
});

describe("setupPlayer", () => {
  it("in a web project: npm-installs the player and prints the module snippet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-"));
    writeFileSync(join(dir, "package.json"), "{}");
    const { io, read } = fakeIO();
    const exec = vi.fn(async () => 0);
    const code = await setupPlayer("https://demos.fldl.space", dir, io, {
      exec, writeFile: async () => {}, fetchFn: fetch, sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledWith("npm", ["install", "@demo-locker/player"]);
    expect(read()).toContain('import "@demo-locker/player"');
  });

  it("outside a project: prints the script-tag snippet, installs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dlp-"));
    const { io, read } = fakeIO();
    const exec = vi.fn(async () => 0);
    const code = await setupPlayer("https://demos.fldl.space", dir, io, {
      exec, writeFile: async () => {}, fetchFn: fetch, sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(read()).toContain("/embed.js");
  });
});
