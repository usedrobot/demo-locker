import { describe, it, expect } from "vitest";
import app from "../index.js";

describe("GET /openapi.json", () => {
  it("serves the binding content as JSON", async () => {
    const res = await app.request("/openapi.json", {}, { OPENAPI_JSON: '{"openapi":"3.1.0"}' });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { openapi: string };
    expect(body.openapi).toBe("3.1.0");
  });

  it("404s cleanly when the binding is absent", async () => {
    const res = await app.request("/openapi.json", {}, {});
    expect(res.status).toBe(404);
  });
});
