import { describe, it, expect } from "vitest";
import { generateId } from "./ids.js";

describe("generateId", () => {
  it("returns UUID-format strings", () => {
    expect(generateId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns unique values", () => {
    expect(generateId()).not.toBe(generateId());
  });
});
