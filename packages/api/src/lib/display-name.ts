// Turn the attribution ids on a page of rows into names, once per response.
//
// `tracks.uploaded_by` and `playlists.created_by` say WHO, but the id itself
// never goes to a client (lib/public-track.ts spells out why at length). The
// booleans that replaced it — `uploadedByMe`, `createdByMe` — answer "is this
// row mine", which in a locker with two songwriters can never say WHICH of them
// a demo came from. That is the thing this branch was opened to show, so the
// name has to be resolved here, server-side, and travel on its own.
//
// A name is `users.display_name` if set, otherwise the account's email.
// display_name is copied from the invite label at redemption (routes/auth.ts):
// the human name the owner typed when minting. The locker owner has no invite
// and therefore no label, and anyone who redeemed before that column existed
// has NULL — both fall back to the address. Email is the fallback, not the
// default: where a display name exists, one collaborator never learns another's
// login address.
//
// ONE QUERY PER RESPONSE, not one per row. Both serializers are called over
// lists — a 200-track library would otherwise issue 200 selects — so the route
// collects the distinct ids off the rows it already loaded and resolves them in
// a single `WHERE id IN (...)`. Rows share uploaders, so the id set is the
// number of PEOPLE in the locker, not the number of rows. A joined select on
// each list query would also work, but would have to be repeated (and kept
// correct) at all eight call sites and would widen every row type; this keeps
// the serializers taking plain rows.

import { inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users } from "../db/schema.js";

// How long a display name may be. ONE cap for one kind of value: this column
// is also filled from collaboratorInvites.label at redemption, so a limit that
// differed from the label's would let a name in by one door that the other
// refuses — and the label route already had this number.
export const MAX_DISPLAY_NAME_CHARS = 100;

// id -> the name to show for that account. An id that is absent resolves to no
// name, which is the same "render nothing" outcome as no attribution at all.
export type DisplayNames = ReadonlyMap<string, string>;

export const NO_NAMES: DisplayNames = new Map();

// Resolve the names for one response's worth of attribution ids.
//
// A reader with no locker session (`actingUserId` null — an anonymous share or
// invite holder) gets nothing, and costs no query. Share links go to people
// outside the locker: the band's names are not part of what a listen link
// grants, and DL's ruling was about telling collaborators' work apart from each
// other's. The serializers enforce this too, so a route that forgets to gate
// still cannot leak; skipping the query here is the saving, not the guard.
export async function resolveDisplayNames(
  db: Database,
  actingUserId: string | null,
  ids: (string | null)[]
): Promise<DisplayNames> {
  if (actingUserId === null) return NO_NAMES;

  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return NO_NAMES;

  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, wanted));

  // Annotated because the drizzle select builder widens to `any` here, exactly
  // as it does at the route call sites — without it the callback parameter is
  // implicitly any and the shape goes unchecked.
  type NameRow = { id: string; displayName: string | null; email: string };
  return new Map(rows.map((r: NameRow) => [r.id, r.displayName ?? r.email]));
}
