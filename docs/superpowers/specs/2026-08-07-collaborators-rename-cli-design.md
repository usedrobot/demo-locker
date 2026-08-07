# Collaborators, playlist rename, and a CLI content client

**Date:** 2026-08-07
**Status:** approved by DL, ready for planning

Three changes, driven by one scenario: a band with more than one songwriter, where
both write demos and both need to put them in the same locker.

- **Collaborators** — invited people who share the owner's library and can upload
  tracks and create playlists, not just comment.
- **Playlist rename** — an affordance that is missing from the UI even though the
  API has always supported it.
- **CLI content commands** — if you set your locker up from a terminal, you should
  be able to run it from one.

## Why the current model does not cover this

Verified in code, 2026-08-07:

- `shares` has no user column. Permissions attach to **links**, not people, and
  each share is scoped to exactly one playlist. `lib/playlist-access.ts` states
  this in its header comment: there is no collaborator-*user* relation.
- Registration closes permanently once the instance has an owner
  (`routes/auth.ts:37`, shipped in 0.2.8), on the premise that a Demo Locker is
  one person's locker and collaborators arrive by share link.
- An `edit` share already grants upload and reorder, but only inside one
  playlist. Everything above the playlist — `POST /playlists`, `GET /tracks`,
  `PATCH /tracks/:id` — is owner-session only.
- Collaborator uploads are attributed to the **owner**: `requestCanEditPlaylist`
  returns the owner's id and `tracks.ts:62` writes it as `ownerId`. So even where
  a co-writer can upload today, the track shows up as the owner's.

The last point is the real gap for a two-songwriter band. The felt problem is
*whose demo is this*, not *may they upload*.

### The edit-share UI is also half-missing

Independently of the model, the existing edit capability barely surfaces:

- `SharePanel.tsx:26` hardcodes `api.create(playlistId, "listen")`. The
  `[+ share link]` button cannot mint an edit link at all, though the API takes
  the argument.
- Granting edit means leaving the playlist, going to Home, opening `[access]`,
  and finding the token in a list (`Home.tsx:328`). The only in-app pointer is a
  hint line at `SharePanel.tsx:104`.
- `shares.email` exists in the schema and `POST /shares` accepts it, but
  SharePanel never sends it — so the access list is a row of anonymous tokens
  with no indication which one belongs to whom.

The receiving end does work: `Invite.tsx:64,127` renders the upload control and
drag-reorder for an `edit` token.

## Section 1 — Collaborators

### Data model

Three additive nullable columns. No existing row is re-parented and no join
table is introduced.

| Column | Meaning |
|---|---|
| `users.locker_owner_id` (FK → users.id) | Null = you own a locker. Set = you are a collaborator on that locker. |
| `tracks.uploaded_by` (FK → users.id) | Who put the file there. Null on pre-existing rows, read as the owner. |
| `playlists.created_by` (FK → users.id) | Same, for playlists. |

`tracks.ownerId` and `playlists.ownerId` keep their current meaning — *which
locker this belongs to* — and continue to point at the owner. That is what keeps
this cheap: the library stays one owner's, and we widen who may act on it.

### Access control

One new resolver:

```
lockerOwnerId(session) => user.lockerOwnerId ?? user.id
```

The 14 ownership checks change from `row.ownerId === userId` to
`row.ownerId === lockerOwnerId(session)`. The full list, verified 2026-08-07:

- `routes/playlists.ts` — 27, 45, 101, 136, 215
- `routes/tracks.ts` — 86, 140, 259, 270
- `routes/shares.ts` — 31, 83, 110, 134, 165

**Deletion is the exception.** DL's rule: a collaborator may delete only what
they uploaded.

- `DELETE /tracks/:id` additionally requires `track.uploadedBy === session.userId`
  unless the caller is the owner. This is the guard that matters — track deletion
  erases the lossless master from the bucket with no undo (`tracks.ts:286`).
- `DELETE /playlists/:id` applies the same rule against `createdBy`, for
  consistency. Note this one is not destructive: migration 0003's
  `ON DELETE SET NULL` detaches a playlist's tracks rather than deleting them.

### Invites

The owner mints a collaborator invite carrying a label, so the access list says
who a grant is for. The invitee opens it, sets an email and password, and gets an
account whose `lockerOwnerId` is the owner.

This threads through the existing closed-registration check rather than reopening
it. Signup stays closed to the open internet; a valid, unused invite is the only
thing that opens it, and only once.

### Explicitly out of scope

No per-playlist permissions for collaborators (they are locker-wide), no
ownership transfer, and collaborators cannot invite further collaborators. None
are needed for a band and all are additive later.

### Share-link UI, fixed alongside

The same feature seen from outside the locker. `SharePanel` learns to mint an
edit link directly instead of hardcoding `"listen"`, and to attach a label. Both
arguments are already accepted by `POST /shares` — this is a web-side change
only.

### Product consequence

A Demo Locker is no longer strictly one person's. This reverses the premise
behind closing signup in 0.2.8. DL's call, made 2026-08-07 with that tradeoff
stated. The closed-signup *mechanism* survives intact — it is what invites gate
against.

**Brochure copy is deliberately not touched by either plan.** `site/` still
describes a single-owner locker. DL's call 2026-08-07: revisit after this ships
and is launched. Neither plan should quietly amend marketing copy as a side
effect, and neither is blocked on it.

### Testing

- Each of the 14 call sites gets a collaborator-can / collaborator-cannot pair.
- Both delete guards get an explicit "someone else's upload" case.
- **Mutation-check the two delete guards**: remove the guard, the test must fail.
  A test that still passes with the fix removed is not a test — the standing
  lesson from the upload-transcode branch.

## Section 2 — Playlist rename

No server work. `PATCH /playlists/:id` already accepts `{name}`
(`routes/playlists.ts:106`) and `packages/web/src/lib/api.ts:136` already wraps
it. Nothing calls it with a name.

Add an inline edit to the playlist title (`PlaylistView.tsx:115`). The title
renders as figlet art through `AsciiText`, so the control is a text input that
swaps in on click, not an editable heading. Enter commits, Escape cancels.

Collaborators may rename, per Section 1.

## Section 3 — CLI content commands

### Shape

Bare `npx demo-locker` stays the install wizard and `--upgrade` stays as-is —
both are load-bearing and the brochure's CTA prompt points at them. Content
commands arrive as subcommands:

```
demo-locker login | logout | whoami
demo-locker playlists list | create <name> | rename <id> <name> | rm <id>
demo-locker tracks list | upload <file...> [--playlist <id>] | mv <id> --playlist <id> | rm <id>
demo-locker collab invite --label "Jimmy"
```

Every prompt keeps a non-interactive flag, per the existing CLI convention, and
every command supports `--json`.

`--json` is the deliberate agentic answer. An instance already serves
`/openapi.json` and the repo ships `AGENTS.md`, so an agent can create or rename
a playlist with curl today and a CLI wrapper adds nothing. The one thing curl
cannot do is upload a track properly. Putting that behind `--json` gives agents
the capability they lack without building a second product. A dedicated MCP
server remains parked and would share this client core rather than compete with
it.

### Auth

`login` posts to `/auth/login` and stores the returned session token in
`~/.config/demo-locker/config.json` at mode 0600, keyed by instance URL so more
than one locker can be held at once. Never in the repo, never in an env var,
never echoed.

Sessions last 30 days (`routes/auth.ts:62`). The server stores only a hash of the
token (`lib/session.ts:50`), so the config file holds the sole copy of the raw
credential — hence 0600. An expired token produces a clean "run
`demo-locker login`", not a 401 traceback.

### Upload

This is the substance of the feature. A track needs three things the browser
computes today and curl cannot supply: `duration`, `waveformData`, and a 256k AAC
rendition. Without them a track streams the 1.4 Mbit/s master and renders the
`╍╍╍` placeholder waveform.

The CLI computes all three locally via **ffmpeg**, decoding to PCM once and
deriving peaks from the same decode — mirroring the single-decode pattern in
`packages/web`.

Two constraints carried from prior bugs:

- **Peaks must not drift.** `peaksFromBuffer` lives at
  `packages/web/src/lib/peaks.ts`. Extract that one function to a shared location
  both packages import, with a test pinning CLI output against a
  browser-generated fixture. The alternative — porting it — leaves two waveform
  algorithms to diverge silently.
- **No silent fallback.** Missing ffmpeg makes `upload` fail with an install
  hint. It must not quietly upload the master alone: that reintroduces the exact
  defect review caught on the transcode branch, where an unsupported encoder
  config fell back to the 1.4 Mbit/s WAV and silently undid the feature.
  `--no-rendition` is the explicit escape hatch and prints what it costs.

ffmpeg is a hard requirement for `upload` only. Every other command runs without
it. DL's call, 2026-08-07.

## Sequencing

Two implementation plans, not one. Section 3 depends on both others — the CLI
exposes `collab invite` and `playlists rename`.

1. **Plan A — Collaborators + rename.** Migration, the resolver, 14 call sites,
   the two delete guards, the invite flow, SharePanel and the rename control.
2. **Plan B — CLI content client.** Subcommand layer, auth and config storage,
   the shared peaks extraction, the ffmpeg upload pipeline, the commands.

## Verification beyond tests

Per the standing lesson that reviews validate reasoning while only use validates
behaviour, both plans finish against the live instance at
`demolocker.dlisok.com`, not just a green suite:

- Invite a second account, upload from it, confirm the track is attributed to
  that account and that it cannot delete one of DL's masters.
- Upload the same file through the browser and through the CLI, and compare
  `/stream` and `/download` byte sizes plus the rendered waveform. Note that
  `hasStream` cannot verify a rendition — it is always true after a successful
  upload (`tracks.ts:105`). Byte sizes are the real check.
