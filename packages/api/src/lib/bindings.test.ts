// A config var that the Node entry point forgets to forward is a setting that
// silently does nothing on every self-hosted install while working fine on
// Workers — the failure mode MAX_STORAGE_BYTES shipped with for four releases.
// This walks the real server source so a var added to types.ts (and documented)
// but not forwarded fails here rather than in someone's deployment.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FORWARDED_ENV_VARS, forwardedEnv } from "./bindings.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("forwardedEnv", () => {
  it("copies every listed var, including absent ones", () => {
    const out = forwardedEnv({ ALLOW_SIGNUP: "true", MAX_PLAYLISTS: "3" });
    expect(out.ALLOW_SIGNUP).toBe("true");
    expect(out.MAX_PLAYLISTS).toBe("3");
    expect(Object.keys(out).sort()).toEqual([...FORWARDED_ENV_VARS].sort());
  });

  it("ignores vars that aren't on the list", () => {
    const out = forwardedEnv({ SECRET_THING: "no" });
    expect(out).not.toHaveProperty("SECRET_THING");
  });
});

describe("config bindings reach the self-hosted server", () => {
  it("forwards every optional config var declared in types.ts", () => {
    const types = readFileSync(join(here, "..", "types.ts"), "utf8");

    // Bindings that are wired by hand for a reason: storage/db handles and the
    // two asset blobs the Node entry reads off disk rather than from env.
    const notConfig = new Set([
      "DB",
      "DEMOS_BUCKET",
      "EMBED_JS",
      "OPENAPI_JSON",
    ]);

    const declared = [...types.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\??:/gm)]
      .map((m) => m[1])
      .filter((name) => !notConfig.has(name));

    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(
        FORWARDED_ENV_VARS as readonly string[],
        `${name} is declared in Bindings but never forwarded in server.ts — it would be ignored on every self-hosted install`
      ).toContain(name);
    }
  });

  it("server.ts actually spreads the shared list", () => {
    const server = readFileSync(join(here, "..", "server.ts"), "utf8");
    expect(server).toContain("...forwardedEnv(process.env)");
  });
});
