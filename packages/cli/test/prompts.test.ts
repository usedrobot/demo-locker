import { describe, it, expect } from "vitest";
import { ask, select } from "../src/prompts.js";
import { fakeIO } from "./helpers.js";

describe("ask", () => {
  it("returns typed answer", async () => {
    const { io, write } = fakeIO();
    const p = ask(io, "Port?", "3001");
    write("4000\n");
    expect(await p).toBe("4000");
  });

  it("returns default on empty input", async () => {
    const { io, write } = fakeIO();
    const p = ask(io, "Port?", "3001");
    write("\n");
    expect(await p).toBe("3001");
  });
});

describe("select", () => {
  const choices = [
    { value: "docker", label: "Docker on this machine" },
    { value: "fly", label: "Fly.io" },
  ] as const;

  it("accepts a number", async () => {
    const { io, write } = fakeIO();
    const p = select(io, "Target?", [...choices], "docker");
    write("2\n");
    expect(await p).toBe("fly");
  });

  it("accepts the value itself", async () => {
    const { io, write } = fakeIO();
    const p = select(io, "Target?", [...choices], "docker");
    write("fly\n");
    expect(await p).toBe("fly");
  });

  it("returns default on empty input and re-asks on garbage", async () => {
    const { io, write, read } = fakeIO();
    const p1 = select(io, "Target?", [...choices], "docker");
    write("nonsense\n");
    write("\n");
    expect(await p1).toBe("docker");
    expect(read()).toContain("Please answer 1-2");
  });
});
