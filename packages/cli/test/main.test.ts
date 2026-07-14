import { describe, it, expect } from "vitest";
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
