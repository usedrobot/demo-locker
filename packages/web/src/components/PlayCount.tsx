// A track's play count, sitting next to the duration in a row. `count` is
// context-dependent upstream (total in the library, per-playlist inside a
// playlist — see Track.plays), so the caller says which in `scope`. Renders
// nothing when the listing carried no count (public and invite views).
type Props = {
  count: number | undefined;
  scope: "library" | "playlist";
};

export default function PlayCount({ count, scope }: Props) {
  if (count === undefined) return null;
  const noun = count === 1 ? "play" : "plays";
  const where = scope === "playlist" ? " in this playlist" : "";
  return (
    <span
      title={`${count} ${noun}${where}`}
      aria-label={`${count} ${noun}${where}`}
      style={{
        color: count === 0 ? "var(--border)" : "var(--fg-dim)",
        fontSize: "12px",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        flex: "none",
      }}
    >
      ▶ {count}
    </span>
  );
}
