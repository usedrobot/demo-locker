import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createSqliteDb } from "./sqlite.js";
import { users, playlists, tracks, collaboratorInvites } from "./schema.js";

describe("createSqliteDb", () => {
  it("migrates and round-trips a row with generated id and Date timestamp", async () => {
    const db = createSqliteDb(); // in-memory
    await db.insert(users).values({ email: "sqlite@test.dev", passwordHash: "x" });
    const [found] = await db.select().from(users).where(eq(users.email, "sqlite@test.dev"));
    expect(found.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(found.createdAt).toBeInstanceOf(Date);
  });
});

describe("collaboration schema", () => {
  it("stores a collaborator bound to an owner's locker", async () => {
    const db = createSqliteDb();
    const [owner] = await db
      .insert(users)
      .values({ email: "owner@test.dev", passwordHash: "x" })
      .returning();
    const [collab] = await db
      .insert(users)
      .values({
        email: "collab@test.dev",
        passwordHash: "x",
        lockerOwnerId: owner.id,
      })
      .returning();

    expect(collab.lockerOwnerId).toBe(owner.id);
    expect(owner.lockerOwnerId).toBeNull();
  });

  it("nulls attribution instead of blocking the delete when a collaborator is removed", async () => {
    const db = createSqliteDb();
    const [owner] = await db
      .insert(users)
      .values({ email: "o2@test.dev", passwordHash: "x" })
      .returning();
    const [collab] = await db
      .insert(users)
      .values({ email: "c2@test.dev", passwordHash: "x", lockerOwnerId: owner.id })
      .returning();
    const [pl] = await db
      .insert(playlists)
      .values({ ownerId: owner.id, name: "demos", createdBy: collab.id })
      .returning();
    const [tr] = await db
      .insert(tracks)
      .values({
        ownerId: owner.id,
        playlistId: pl.id,
        title: "riff",
        position: 0,
        originalKey: "k",
        uploadedBy: collab.id,
      })
      .returning();

    await db.delete(users).where(eq(users.id, collab.id));

    const [track] = await db.select().from(tracks).where(eq(tracks.id, tr.id));
    const [playlist] = await db.select().from(playlists).where(eq(playlists.id, pl.id));
    expect(track.uploadedBy).toBeNull();
    expect(track.ownerId).toBe(owner.id);
    expect(playlist.createdBy).toBeNull();
  });

  it("removes a collaborator's account when the owner is deleted", async () => {
    const db = createSqliteDb();
    const [owner] = await db
      .insert(users)
      .values({ email: "o4@test.dev", passwordHash: "x" })
      .returning();
    const [collab] = await db
      .insert(users)
      .values({ email: "c4@test.dev", passwordHash: "x", lockerOwnerId: owner.id })
      .returning();

    await db.delete(users).where(eq(users.id, owner.id));

    const [found] = await db.select().from(users).where(eq(users.id, collab.id));
    expect(found).toBeUndefined();
  });

  it("stores an unredeemed collaborator invite", async () => {
    const db = createSqliteDb();
    const [owner] = await db
      .insert(users)
      .values({ email: "o3@test.dev", passwordHash: "x" })
      .returning();
    const [invite] = await db
      .insert(collaboratorInvites)
      .values({ ownerId: owner.id, token: "inv-token", label: "Jimmy" })
      .returning();

    expect(invite.label).toBe("Jimmy");
    expect(invite.acceptedBy).toBeNull();
  });
});
