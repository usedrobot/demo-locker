import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function createD1Db(binding: unknown): Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(binding as any, { schema });
}

let _factory: ((binding: unknown) => Db) | null = null;
let _db: Db = null;
let _lastBinding: unknown = null;

// Self-hosted: call this to swap in the sqlite driver
export function setDbFactory(factory: (binding: unknown) => Db) {
  _factory = factory;
  _db = null;
}

export function getDb(binding: unknown): Db {
  if (_db && _lastBinding === binding) return _db;
  _lastBinding = binding;
  _db = _factory ? _factory(binding) : createD1Db(binding);
  return _db;
}

export type Database = Db;
