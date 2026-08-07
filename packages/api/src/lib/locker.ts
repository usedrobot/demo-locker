// Which locker is this session acting in?
//
// A Demo Locker belongs to exactly one owner. Collaborators are users whose
// `lockerOwnerId` points at that owner: they share the library rather than
// having one of their own, so every `ownerId` column on tracks and playlists
// keeps pointing at the owner no matter who created the row.
//
// This is what the ownership checks across playlists/tracks/shares compare
// against.
//
// Two forms exist because callers arrive in two different shapes:
//   - `lockerIdOf` is pure and synchronous — requireAuth has already loaded
//     the `User`, so asking "which locker" must never cost another query.
//   - `lockerIdForUserId` is for the gates that receive only a raw token and
//     a `db`, with no `User` loaded (canAccessPlaylist isn't even given a
//     Context), so the session path pays one extra select.

import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users } from "../db/schema.js";
import type { User } from "../types.js";

export function lockerIdOf(user: User): string {
  return user.lockerOwnerId ?? user.id;
}

export async function lockerIdForUserId(db: Database, userId: string): Promise<string> {
  const [row] = await db
    .select({ lockerOwnerId: users.lockerOwnerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.lockerOwnerId ?? userId;
}

// True only for the account that owns the locker. Gates the things that are
// locker-level rather than library-level: inviting collaborators and
// publishing a playlist.
export function isLockerOwner(user: User): boolean {
  return user.lockerOwnerId === null;
}
