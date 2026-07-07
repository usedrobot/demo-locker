import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createPgliteDb } from "./pglite.js";
import { users, comments, playlists } from "./schema.js";

describe("createPgliteDb", () => {
  it("boots an in-memory db, runs migrations, and round-trips a row", async () => {
    const db = await createPgliteDb(); // no dataDir → in-memory

    const [user] = await db
      .insert(users)
      .values({ email: "pglite@test.dev", passwordHash: "x" })
      .returning();
    expect(user.id).toBeTruthy();

    const found = await db.select().from(users).where(eq(users.email, "pglite@test.dev"));
    expect(found).toHaveLength(1);
  });

  it("has the migration-drift columns from 0001 (comments.resolved_at etc.)", async () => {
    const db = await createPgliteDb();
    // insert exercising the columns that only exist if migration 0001 ran
    const [row] = await db
      .insert(comments)
      .values({ authorName: "t", body: "b", deleteToken: "tok" })
      .returning();
    expect(row.deleteToken).toBe("tok");
  });

  it("playlists have is_public defaulting to false", async () => {
    const db = await createPgliteDb();
    const [user] = await db
      .insert(users)
      .values({ email: "pub@test.dev", passwordHash: "x" })
      .returning();
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId: user.id, name: "p" })
      .returning();
    expect(pl.isPublic).toBe(false);
  });
});
