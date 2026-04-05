import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function createNeonDb(url: string): Db {
  const sql = neon(url);
  return drizzle(sql, { schema });
}

let _factory: ((url: string) => Db) | null = null;
let _db: Db = null;
let _lastUrl: string | null = null;

// Self-hosted: call this to swap in the postgres driver
export function setDbFactory(factory: (url: string) => Db) {
  _factory = factory;
  _db = null;
}

export function getDb(url: string): Db {
  if (_db && _lastUrl === url) return _db;
  _lastUrl = url;
  _db = _factory ? _factory(url) : createNeonDb(url);
  return _db;
}

export type Database = Db;
