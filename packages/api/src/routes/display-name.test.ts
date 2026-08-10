// Naming yourself.
//
// users.display_name had exactly one writer — the invite label, copied at
// redemption — and the locker owner has no invite by definition. So the owner's
// name was NULL forever and every row they uploaded showed their login address
// to every collaborator, permanently, with no way to change it: the exact
// disclosure display names existed to avoid, inverted onto the one person who
// could not opt out.
//
// The route is open to any authenticated session, not owner-only: a
// collaborator whose name the owner mistyped when inviting them can correct it.
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import app from "../index.js";
import { setDbFactory, type Database } from "../db/index.js";
import { createSqliteDb } from "../db/sqlite.js";
import { users } from "../db/schema.js";
import { MAX_DISPLAY_NAME_CHARS } from "../lib/display-name.js";

let db: Database;
let env: Record<string, unknown>;
let ownerToken: string;
let collabToken: string;

const OWNER_EMAIL = "name-owner@test.dev";
const OWNER_PASSWORD = "owner-password";
const COLLAB_EMAIL = "name-collab@test.dev";

const json = (body: unknown, token?: string) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

async function setName(displayName: unknown, token = ownerToken): Promise<Response> {
  return app.request("/auth/display-name", json({ displayName }, token), env);
}

async function storedName(email: string): Promise<string | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  expect(row, `no account for ${email}`).toBeDefined();
  return row.displayName;
}

async function me(token: string): Promise<{ displayName: string | null; email: string }> {
  const res = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } }, env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { user: { displayName: string | null; email: string } }).user;
}

beforeAll(async () => {
  db = createSqliteDb();
  setDbFactory(() => db);
  // Two accounts: the locker owner, and a collaborator who redeemed an invite.
  env = { DB: "sqlite", DEMOS_BUCKET: {} };

  const signup = await app.request(
    "/auth/signup",
    json({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    env
  );
  expect(signup.status).toBe(201);
  ownerToken = ((await signup.json()) as { token: string }).token;

  const invite = await app.request("/collab/invites", json({ label: "Jmimy" }, ownerToken), env);
  expect(invite.status).toBe(201);
  const inviteToken = ((await invite.json()) as { invite: { token: string } }).invite.token;

  const joined = await app.request(
    "/auth/signup",
    json({ email: COLLAB_EMAIL, password: "collab-password", inviteToken }),
    env
  );
  expect(joined.status).toBe(201);
  const body = (await joined.json()) as { token: string; user: { displayName: string | null } };
  collabToken = body.token;
  // The settings field has to render the current value on load, so the account
  // responses have to carry it.
  expect(body.user.displayName).toBe("Jmimy");
});

describe("POST /auth/display-name", () => {
  it("requires authentication", async () => {
    const res = await app.request("/auth/display-name", json({ displayName: "Nobody" }), env);
    expect(res.status).toBe(401);
  });

  it("stores a name and returns what was stored", async () => {
    const res = await setName("  Dave  ");
    expect(res.status).toBe(200);
    // Returned so the client can confirm what was saved — trimmed, not as typed.
    expect((await res.json()) as { displayName: string | null }).toEqual({ displayName: "Dave" });
    expect(await storedName(OWNER_EMAIL)).toBe("Dave");
  });

  it("serves the stored name from /auth/me and from login", async () => {
    expect((await setName("Dave")).status).toBe(200);
    expect((await me(ownerToken)).displayName).toBe("Dave");

    const login = await app.request(
      "/auth/login",
      json({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
      env
    );
    expect(login.status).toBe(200);
    const user = ((await login.json()) as { user: { displayName: string | null } }).user;
    expect(user.displayName).toBe("Dave");
  });

  it("clears to NULL rather than an empty string", async () => {
    expect((await setName("Dave")).status).toBe(200);

    const res = await setName("   ");
    expect(res.status).toBe(200);
    expect((await res.json()) as { displayName: string | null }).toEqual({ displayName: null });
    // NULL, not "": `displayName ?? email` reads NULL as unset and falls back to
    // the address, where an empty string would render as a blank name.
    expect(await storedName(OWNER_EMAIL)).toBeNull();
    expect((await me(ownerToken)).displayName).toBeNull();
  });

  it("rejects a non-string, and stores nothing", async () => {
    expect((await setName("Dave")).status).toBe(200);

    expect((await setName(null)).status).toBe(400);
    expect((await setName(42)).status).toBe(400);
    expect((await setName({ toString: "no" })).status).toBe(400);

    expect(await storedName(OWNER_EMAIL)).toBe("Dave");
  });

  it("rejects a name longer than the cap, and stores nothing", async () => {
    expect((await setName("Dave")).status).toBe(200);

    // Same cap as the invite label this column is otherwise filled from — one
    // limit for one kind of value.
    const tooLong = "d".repeat(MAX_DISPLAY_NAME_CHARS + 1);
    expect((await setName(tooLong)).status).toBe(400);
    // The cap is measured after trimming, so padding cannot smuggle one past.
    expect((await setName(`  ${tooLong}  `)).status).toBe(400);
    expect(await storedName(OWNER_EMAIL)).toBe("Dave");

    const atCap = "d".repeat(MAX_DISPLAY_NAME_CHARS);
    expect((await setName(atCap)).status).toBe(200);
    expect(await storedName(OWNER_EMAIL)).toBe(atCap);
  });

  it("rejects control characters and newlines, and stores nothing", async () => {
    expect((await setName("Dave")).status).toBe(200);

    // A name is rendered as text content, which React escapes — so this is not
    // an injection guard. It is a layout and impersonation guard: a newline
    // makes one row's name occupy two, and a run of them can push a second
    // fake attribution onto the screen.
    for (const bad of ["Dave\nthe owner", "Dave\r\nowner", "Dave\u0000", "Dave\u001b[31m", "Dave\tsmith"]) {
      const res = await setName(bad);
      expect(res.status, `${JSON.stringify(bad)} was accepted`).toBe(400);
    }
    expect(await storedName(OWNER_EMAIL)).toBe("Dave");
  });

  // \n, \r and \t are all in the refused class AND are all removed by trim().
  // Testing the raw value therefore refused a pasted trailing newline that
  // trimming would have taken off anyway — while openapi documents whitespace
  // as the way to UNSET. Trim first, then test: the interior newline the rule
  // exists for is still caught (the case above), the padding is not.
  it("trims a pasted trailing newline rather than refusing it", async () => {
    const res = await setName("Dave\n");
    expect(res.status).toBe(200);
    expect((await res.json()) as { displayName: string | null }).toEqual({ displayName: "Dave" });
    expect(await storedName(OWNER_EMAIL)).toBe("Dave");
  });

  it("reads a whitespace-only value containing a newline as unset", async () => {
    expect((await setName("Dave")).status).toBe(200);

    const res = await setName("  \n ");
    expect(res.status).toBe(200);
    expect(await storedName(OWNER_EMAIL)).toBeNull();
  });

  it("lets a collaborator correct the name the owner mistyped for them", async () => {
    const res = await setName("Jimmy", collabToken);
    expect(res.status).toBe(200);
    expect(await storedName(COLLAB_EMAIL)).toBe("Jimmy");
    // and did not touch anyone else's
    expect((await me(collabToken)).email).toBe(COLLAB_EMAIL);
    expect(await storedName(OWNER_EMAIL)).not.toBe("Jimmy");
  });
});

// THE SECOND DOOR. users.display_name has two writers, not one: this route,
// and the invite label that routes/auth.ts copies into the column verbatim at
// redemption. A rule enforced on one of them is not enforced at all — the value
// simply arrives by the other, and by then it is a collaborator's name, shown
// to every member on every row they touch, changeable only by that person and
// only if they know to.
//
// Nothing exercised the label against these rules before, which is how the
// character class came to guard one door for a release.
describe("POST /collab/invites holds the label to the same rules", () => {
  async function mint(label: unknown): Promise<Response> {
    return app.request("/collab/invites", json({ label }, ownerToken), env);
  }

  async function labels(): Promise<string[]> {
    const res = await app.request(
      "/collab/invites",
      { headers: { Authorization: `Bearer ${ownerToken}` } },
      env
    );
    expect(res.status).toBe(200);
    const { invites } = (await res.json()) as { invites: { label: string }[] };
    return invites.map((i) => i.label);
  }

  it("refuses a label carrying control characters or newlines, and mints nothing", async () => {
    const before = await labels();

    const bad = [
      "Jimmy\nJimmy",
      "Jimmy\r\nJimmy",
      `Jimmy${String.fromCharCode(0)}`,
      `Jimmy${String.fromCharCode(27)}[31m`,
      "Jimmy\tJimmy",
    ];
    for (const label of bad) {
      const res = await mint(label);
      expect(res.status, `${JSON.stringify(label)} was accepted as a label`).toBe(400);
    }

    // Pin that no row was written: a "no such label" assertion would pass on an
    // empty list whether or not the guard fired.
    const after = await labels();
    expect(after).toEqual(before);
    expect(after.some((l) => l.includes("\n"))).toBe(false);
  });

  it("refuses a label longer than the cap, measured after trimming", async () => {
    const before = await labels();
    const tooLong = "j".repeat(MAX_DISPLAY_NAME_CHARS + 1);

    const res = await mint(tooLong);
    expect(res.status).toBe(400);
    // The wording clients already read for this case, unchanged.
    expect((await res.json()) as { error: string }).toEqual({
      error: `label must be ${MAX_DISPLAY_NAME_CHARS} characters or fewer`,
    });

    // Padding must not smuggle one past — this is the half the label door had
    // wrong, measuring the raw string where the name route measured the trim.
    expect((await mint(`  ${tooLong}  `)).status).toBe(400);
    expect(await labels()).toEqual(before);

    // and the boundary is inclusive, so the cap is a cap and not an off-by-one
    const atCap = "j".repeat(MAX_DISPLAY_NAME_CHARS);
    expect((await mint(atCap)).status).toBe(201);
    expect(await labels()).toContain(atCap);
  });

  it("still refuses a whitespace-only label as missing, and still trims a good one", async () => {
    // Deliberately different from the name route, which reads whitespace as
    // "unset": an owner naming someone else has to have typed something.
    expect((await mint("   ")).status).toBe(400);

    const res = await mint("  Nina  ");
    expect(res.status).toBe(201);
    const { invite } = (await res.json()) as { invite: { label: string } };
    expect(invite.label).toBe("Nina");
  });
});
