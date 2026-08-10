// These tests run under Node, where WebCrypto will happily do any iteration
// count you ask for. The deployed target is Cloudflare Workers, which will not.
// So the first test here is not really a unit test — it is a tripwire standing
// in for a runtime this suite cannot execute.
import { describe, it, expect } from "vitest";
import {
  PBKDF2_ITERATIONS,
  hashPassword,
  verifyPassword,
  needsRehash,
} from "./auth.js";

// Cloudflare Workers' documented-by-error ceiling for PBKDF2. Raising
// PBKDF2_ITERATIONS above this compiles, passes every other test in this
// repo, deploys cleanly, and then throws NotSupportedError on the live
// instance for every request that hashes a password.
const WORKERS_PBKDF2_MAX = 100_000;

describe("PBKDF2 cost", () => {
  // The regression this exists for: PBKDF2_ITERATIONS was 600_000 on main from
  // 2026-07-30 to 2026-08-10. Signup (and so collaborator invite redemption),
  // the password-change route, and login's opportunistic rehash all returned
  // 500 on Workers for eleven days, with 233 green API tests.
  it("stays within what the deploy target can actually do", () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(WORKERS_PBKDF2_MAX);
  });

  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  // The property that decides whether an existing user can still log in.
  // A legacy-format hash parses as 100_000 iterations. While PBKDF2_ITERATIONS
  // was 600_000, needsRehash returned true for every such row, login called
  // hashPassword, and the request threw — locking out the one account on the
  // instance. It fails closed in the worst possible direction: verification
  // succeeds, and the 500 happens after, on the opportunistic upgrade.
  it("does not demand a rehash the runtime cannot perform", () => {
    const legacy = "a".repeat(32) + ":" + "b".repeat(64);
    expect(needsRehash(legacy)).toBe(false);
  });

  it("still demands a rehash for a genuinely weaker stored cost", () => {
    expect(needsRehash(`pbkdf2$1000$${"a".repeat(32)}$${"b".repeat(64)}`)).toBe(true);
  });
});
