import { describe, it, expect } from "vitest";
import { lockerIdOf, isLockerOwner } from "./locker.js";
import type { User } from "../types.js";

const owner: User = { id: "u-owner", email: "o@t.dev", accent: null, lockerOwnerId: null };
const collab: User = { id: "u-collab", email: "c@t.dev", accent: null, lockerOwnerId: "u-owner" };

describe("lockerIdOf", () => {
  it("returns an owner's own id", () => {
    expect(lockerIdOf(owner)).toBe("u-owner");
  });

  it("returns the owner's id for a collaborator", () => {
    expect(lockerIdOf(collab)).toBe("u-owner");
  });
});

describe("isLockerOwner", () => {
  it("is true for an owner", () => {
    expect(isLockerOwner(owner)).toBe(true);
  });

  it("is false for a collaborator", () => {
    expect(isLockerOwner(collab)).toBe(false);
  });
});
