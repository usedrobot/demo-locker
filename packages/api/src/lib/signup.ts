// Who is allowed to create an account.
//
// Registration used to be open on every instance forever, with no way to close
// it: anyone who found the URL could sign up on someone's personal locker. The
// default is now "first account only" — which is exactly what the install
// wizard needs (it creates the owner immediately after deploy) and nothing
// more. Operators running a shared instance can reopen it with ALLOW_SIGNUP.

import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { users } from "../db/schema.js";
import type { Bindings } from "../types.js";

export function signupExplicitlyAllowed(env: Bindings): boolean {
  return (env.ALLOW_SIGNUP ?? "").toLowerCase() === "true";
}

export async function signupAllowed(
  db: Database,
  env: Bindings
): Promise<boolean> {
  if (signupExplicitlyAllowed(env)) return true;

  // Count rather than "select one": the bootstrap case is specifically "this
  // instance has no owner yet".
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(users);
  return Number(row?.count ?? 0) === 0;
}
