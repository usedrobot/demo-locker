// Which locker is this session acting in?
//
// A Demo Locker belongs to exactly one owner. Collaborators are users whose
// `lockerOwnerId` points at that owner: they share the library rather than
// having one of their own, so every `ownerId` column on tracks and playlists
// keeps pointing at the owner no matter who created the row.
//
// This is what the ownership checks across playlists/tracks/shares compare
// against. It is pure and synchronous on purpose — requireAuth has already
// loaded the user, so asking "which locker" must never cost another query.

import type { User } from "../types.js";

export function lockerIdOf(user: User): string {
  return user.lockerOwnerId ?? user.id;
}

// True only for the account that owns the locker. Gates the things that are
// locker-level rather than library-level: inviting collaborators, publishing a
// playlist, and minting share links.
export function isLockerOwner(user: User): boolean {
  return user.lockerOwnerId === null;
}
