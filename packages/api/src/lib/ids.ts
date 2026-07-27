// UUID-format IDs, app-side (SQLite has no uuid default).
// crypto.randomUUID exists on Workers and Node >= 19 — both deploy targets.
export function generateId(): string {
  return crypto.randomUUID();
}
