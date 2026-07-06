import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createPgliteDb } from "./pglite.js";
import { users, comments } from "./schema.js";

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
});
