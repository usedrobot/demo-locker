import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./ids";

describe("randomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns unique non-empty strings", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    }
  });

  it("works when crypto.randomUUID is unavailable (insecure context)", () => {
    // plain-http self-hosted instances have crypto.getRandomValues but NOT
    // crypto.randomUUID — simulate that browser environment
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: real.getRandomValues.bind(real),
    });
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
  });

  it("works even without crypto.getRandomValues", () => {
    vi.stubGlobal("crypto", undefined);
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    expect(ids.size).toBe(100);
  });
});
