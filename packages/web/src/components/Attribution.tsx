// Whose demo is this?
//
// A locker can hold two songwriters both writing into the same library, which
// is the thing this whole feature was opened for — and until now every row read
// the same whoever made it. The server sends a resolved NAME
// (`uploadedByName` / `createdByName`, from users.display_name falling back to
// the email; see packages/api/src/lib/display-name.ts) alongside the
// mine/not-mine boolean it has always sent.
//
// Three rules, all of them load-bearing:
//
//   - The acting user's own rows say "you", never their own name. The row
//     exists to tell YOUR work from THEIRS; reading your own name back at you
//     is noise, and `mine` is the only thing that can be said with certainty
//     about the caller.
//   - No attribution renders NOTHING. Null is what the server sends for a row
//     that predates the column, an uploader since removed, and every reader
//     with no locker session (an anonymous share holder — this same component
//     renders inside TrackList on the invite view). "unknown" or "null" would
//     each be a claim the data does not support.
//   - It is ATTRIBUTION, not permission. Every control on the row works exactly
//     as it did; nothing here gates anything.
//
// Secondary information: it must not displace or wrap the title, which is the
// thing being read. That is a two-part contract and BOTH halves are per-row —
// this branch has fixed the same flex-overflow bug in four separate places by
// fixing only one side of it. Here: the marker is capped and shrinkable
// (`flex: 0 1 auto` + maxWidth + ellipsis) so it can never claim the row; at
// each call site the title span needs `minWidth: 0` so it shrinks instead of
// forcing the row wider than its container.

type Props = {
  // Whether the acting session made this row: `uploadedByMe` / `createdByMe`.
  mine: boolean;
  // The other person's name, or null when there is nothing to attribute.
  name: string | null;
  // Reads into the tooltip — the visible text is a bare name, which on its own
  // does not say what the name means.
  verb: "Uploaded" | "Created";
};

export default function Attribution({ mine, name, verb }: Props) {
  const shown = mine ? "you" : name;
  if (!shown) return null;

  return (
    <span
      data-attribution={shown}
      title={`${verb} by ${mine ? "you" : shown}`}
      style={{
        color: "var(--fg-dim)",
        fontSize: "12px",
        flex: "0 1 auto",
        minWidth: 0,
        maxWidth: "12ch",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {shown}
    </span>
  );
}
