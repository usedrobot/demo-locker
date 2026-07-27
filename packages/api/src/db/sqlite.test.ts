import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createSqliteDb } from "./sqlite.js";
import { users } from "./schema.js";

describe("createSqliteDb", () => {
  it("migrates and round-trips a row with generated id and Date timestamp", async () => {
    const db = createSqliteDb(); // in-memory
    await db.insert(users).values({ email: "sqlite@test.dev", passwordHash: "x" });
    const [found] = await db.select().from(users).where(eq(users.email, "sqlite@test.dev"));
    expect(found.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(found.createdAt).toBeInstanceOf(Date);
  });
});
