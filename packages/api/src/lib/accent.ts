// The accent palette, duplicated from packages/web/src/lib/theme.ts.
//
// The value is written straight into a CSS custom property on the client, so it
// is validated server-side against this allowlist rather than trusted as a
// string: a stored `red; background: url(...)` would otherwise be replayed into
// every listener's stylesheet. An allowlist also keeps the column self-
// describing — anything in there is a colour the UI actually ships.
export const ACCENTS = [
  "#fc0", // gold (default)
  "#f80", // amber
  "#4af", // blue
  "#3f6", // green
  "#f6a", // pink
  "#a6f", // purple
  "#6cf", // cyan
];

export function isValidAccent(value: unknown): value is string {
  return typeof value === "string" && ACCENTS.includes(value);
}
