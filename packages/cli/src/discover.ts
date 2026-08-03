// Finding an instance that already exists.
//
// Discovery runs before planning, not as plan steps: `run-capture` in
// execute.ts hardcodes D1-id extraction and cannot parse arbitrary output.
// These probes take the injected Runner so they stay testable without a real
// account or daemon.

import type { Runner } from "./execute.js";

export interface CloudflareCandidate {
  target: "cloudflare";
  workerName: string;
  d1Name: string;
  d1Id: string;
  r2Bucket: string | null;
  domain: string | null;
}

/**
 * `wrangler d1 list --json` prints a banner before the JSON, so slice from the
 * first bracket. Returns [] on anything unparseable — a discovery probe that
 * throws would abort an upgrade over a wrangler version cosmetic.
 */
export function parseD1List(stdout: string): Array<{ name: string; id: string }> {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  try {
    const rows = JSON.parse(stdout.slice(start)) as Array<{ name?: string; uuid?: string }>;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => typeof r.name === "string" && typeof r.uuid === "string")
      .map((r) => ({ name: r.name as string, id: r.uuid as string }));
  } catch {
    return [];
  }
}

/**
 * The installer names the database `<worker>-db`, so the Worker name is the
 * database name minus that suffix. Verified against `deployments list` before
 * it is trusted — this is a candidate, not an answer.
 */
export function workerNameFromD1(d1Name: string): string | null {
  return d1Name.endsWith("-db") ? d1Name.slice(0, -"-db".length) : null;
}
