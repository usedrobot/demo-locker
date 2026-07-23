// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy-text";

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when clipboard API is missing (insecure context)", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    expect(await copyText("hello")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false when no copy mechanism works", async () => {
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await copyText("hello")).toBe(false);
  });
});
