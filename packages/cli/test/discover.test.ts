import { describe, it, expect } from "vitest";
import { parseD1List, workerNameFromD1 } from "../src/discover.js";

const D1_JSON = JSON.stringify([
  { uuid: "ca6096da-2ca9-4dfa-ba22-5f154cc0a322", name: "demo-locker-dlisok-db", num_tables: 0 },
  { uuid: "0ea573b2-861c-482c-a9c7-de5335d29fa0", name: "demo-locker-db", num_tables: 6 },
  { uuid: "11111111-2222-3333-4444-555555555555", name: "unrelated-thing", num_tables: 2 },
]);

describe("parseD1List", () => {
  it("reads name and uuid for every database", () => {
    expect(parseD1List(D1_JSON)).toEqual([
      { name: "demo-locker-dlisok-db", id: "ca6096da-2ca9-4dfa-ba22-5f154cc0a322" },
      { name: "demo-locker-db", id: "0ea573b2-861c-482c-a9c7-de5335d29fa0" },
      { name: "unrelated-thing", id: "11111111-2222-3333-4444-555555555555" },
    ]);
  });

  it("ignores wrangler banner lines before the JSON", () => {
    const noisy = " ⛅️ wrangler 4.20.4\n----------------\n" + D1_JSON;
    expect(parseD1List(noisy)).toHaveLength(3);
  });

  it("returns [] rather than throwing on unparseable output", () => {
    expect(parseD1List("not json at all")).toEqual([]);
  });

  // num_tables reports 0 for a live, serving database — verified 2026-08-03
  // against demo-locker-dlisok-db. Nothing may filter on it.
  it("does not use num_tables to filter", () => {
    const names = parseD1List(D1_JSON).map((d) => d.name);
    expect(names).toContain("demo-locker-dlisok-db");
  });
});

describe("workerNameFromD1", () => {
  it("strips the -db suffix", () => {
    expect(workerNameFromD1("demo-locker-dlisok-db")).toBe("demo-locker-dlisok");
    expect(workerNameFromD1("demo-locker-db")).toBe("demo-locker");
  });

  it("returns null when the name does not end in -db", () => {
    expect(workerNameFromD1("unrelated-thing")).toBeNull();
  });
});
