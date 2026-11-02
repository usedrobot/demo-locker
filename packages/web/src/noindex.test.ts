// Every Demo Locker is a PRIVATE locker on its owner's own domain, yet nothing
// told search engines so, and demolocker.dlisok.com turned up in Google
// (2026-11-01). Both signals ship with the app so an upgrade cannot drop them:
//   - <meta name="robots"> in index.html covers every target (Workers, Node, Docker)
//   - public/_headers adds X-Robots-Tag on Cloudflare Workers Assets
// Do NOT "fix" indexing with a robots.txt Disallow: a crawler that may not
// fetch the page never sees the noindex, and the bare URL stays listed.
import { describe, it, expect } from "vitest";
import html from "../index.html?raw";
import headers from "../public/_headers?raw";

describe("search engines are told to stay out", () => {
  it("index.html carries a noindex robots meta tag", () => {
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex, nofollow"\s*\/?>/);
  });

  it("public/_headers sends X-Robots-Tag: noindex on every path", () => {
    expect(headers).toMatch(/^\/\*\n\s+X-Robots-Tag: noindex, nofollow$/m);
  });
});
