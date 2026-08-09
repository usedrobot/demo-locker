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

import { and, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users } from "../db/schema.js";

// How long a display name may be. ONE cap for one kind of value: this column
// is also filled from collaboratorInvites.label at redemption, so a limit that
// differed from the label's would let a name in by one door that the other
// refuses — and the label route already had this number.
export const MAX_DISPLAY_NAME_CHARS = 100;

// This is NOT an escaping guard. The name is rendered as text content by React,
// which escapes it, so markup in a name is inert — an allowlist like the
// accent's is neither possible nor needed for free text. What is left after
// escaping is layout and impersonation: a newline lets one person's name take
// two rows and paint a second, fake attribution under it, and a control run can
// hide the rest of a name in a terminal or a log.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// ONE validator for the TWO doors into users.display_name.
//
// POST /auth/display-name writes the column directly; POST /collab/invites
// writes a label that routes/auth.ts copies verbatim into the same column at
// redemption. A rule enforced at one door is not enforced at all — the value
// simply walks in through the other, and once it is a collaborator's name it is
// rendered on every row they touch. The cap was already shared for exactly this
// reason; the character class was not, so `{"label":"Jimmy\nJimmy"}` was
// accepted at mint and became a display name at signup.
//
// TRIM FIRST, then test — for BOTH rules:
//   - characters, because \n, \r and \t are all in the class above AND are all
//     stripped by trim(), so testing the raw value refuses a pasted trailing
//     newline that trimming would have removed, contradicting the documented
//     "send whitespace to unset". The interior newline the rule exists for is
//     still caught either way.
//   - length, because padding must not smuggle a longer name past the cap.
//
// `field` only names the value in the refusal ("name" / "label"), so each route
// keeps the wording its clients already read.
export function validateDisplayName(
  raw: string,
  field: "name" | "label"
): { error: string } | { trimmed: string } {
  const trimmed = raw.trim();
  if (CONTROL_CHARS.test(trimmed)) {
    return { error: `${field} must not contain line breaks or control characters` };
  }
  if (trimmed.length > MAX_DISPLAY_NAME_CHARS) {
    return { error: `${field} must be ${MAX_DISPLAY_NAME_CHARS} characters or fewer` };
  }
  return { trimmed };
}

// One response's resolved attribution.
//
// `byId` maps an account id to the name to show for it; an id that is absent
// resolves to no name, which is the same "render nothing" outcome as no
// attribution at all.
//
// `allowed` is the READER's side of the question and it is carried separately
// on purpose. An empty `byId` cannot express the difference between "you may
// see names, and none of these rows has an uploader to name" and "you are
// outside this locker and may see none" — and the two need different answers,
// because a row whose uploader has been REMOVED carries its name in a snapshot
// column on the row itself (tracks.uploaded_by_name) rather than in this map.
// A serializer that gated on the map alone would hand a departed member's name
// to an outsider. `allowed` is the one gate both paths consult.
export type DisplayNames = {
  readonly allowed: boolean;
  readonly byId: ReadonlyMap<string, string>;
};

export const NO_NAMES: DisplayNames = { allowed: false, byId: new Map() };

// Resolve the names for one response's worth of attribution ids.
//
// NAMES ARE LOCKER-INTERNAL (DL's ruling). Two things follow, and both are
// enforced HERE rather than at the call sites:
//
//   1. The READER must be in `lockerId`. A reader with no session at all — the
//      anonymous share or invite holder — gets nothing, as before. But so does
//      a SIGNED-IN reader who is not a member of this locker: several routes
//      (GET /playlists/:id, GET /shares/:token, POST /tracks/upload) admit a
//      caller on a share token while independently resolving whatever Bearer
//      session the same request happens to carry, so "has a session" was never
//      the same question as "is in this locker". Gating per call site left the
//      main playlist read path leaking; the locker id is a REQUIRED parameter
//      so a forgotten call site is a compile error rather than a silent leak.
//
//   2. The names RESOLVED are only those of accounts in `lockerId`. An id can
//      reach this function from a row written by an outsider — an edit-share
//      holder with an account elsewhere on the instance — and serving that
//      account's self-chosen display name would let a stranger paint an
//      arbitrary name (a bandmate's, say) onto the band's attribution. An id
//      that is not a member resolves to no name, which renders as nothing,
//      exactly like a legacy row with no attribution at all.
//
// `actingUserId` itself is NOT gated: it answers "is this row mine", which is
// safe for any caller and is what gates the delete controls, including on an
// edit-share link. Only the names are locker-internal.
//
// Both facts come out of the SAME query. The acting user's id is added to the
// id set, and the membership predicate is applied to the whole select, so the
// reader is a member precisely when their own row comes back — no second
// round trip on a per-response path.
export async function resolveDisplayNames(
  db: Database,
  actingUserId: string | null,
  lockerId: string,
  ids: (string | null)[]
): Promise<DisplayNames> {
  if (actingUserId === null) return NO_NAMES;

  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  // No early return on an empty id set: the reader's membership still has to be
  // settled, because the serializers gate the departed-member SNAPSHOT on it
  // too and a page of rows whose uploaders have all been removed has no ids to
  // resolve at all. One query answers both questions either way.

  // Membership, in one predicate: the owner IS the locker id, and every
  // collaborator points at it (lib/locker.ts).
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(
      and(
        inArray(users.id, [...new Set([actingUserId, ...wanted])]),
        or(eq(users.id, lockerId), eq(users.lockerOwnerId, lockerId))
      )
    );

  // Annotated because the drizzle select builder widens to `any` here, exactly
  // as it does at the route call sites — without it the callback parameter is
  // implicitly any and the shape goes unchecked.
  type NameRow = { id: string; displayName: string | null; email: string };
  const members = rows as NameRow[];

  // The reader's own row is present only if the reader is in this locker.
  if (!members.some((r) => r.id === actingUserId)) return NO_NAMES;

  const asked = new Set(wanted);
  return {
    allowed: true,
    byId: new Map(
      members.filter((r) => asked.has(r.id)).map((r) => [r.id, r.displayName ?? r.email])
    ),
  };
}
