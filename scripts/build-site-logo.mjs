// Regenerates the brochure wordmark in site/index.html from the SAME art and
// the SAME geometry the app uses.
//
//   npx tsx scripts/build-site-logo.mjs
//
// WHY THIS EXISTS. site/ is a separate deploy target (the `demo-locker` Pages
// project, see deploy-site in .github/workflows/ci.yml) with no bundler, so it
// cannot import the app's PixelArt component — it needs literal markup in a
// literal HTML file. That is a duplicate, and a hand-maintained duplicate of
// something that also lives in code is a latent outage: change the wordmark in
// packages/web and the brochure silently keeps the old one.
//
// So the markup is DERIVED rather than typed. logo-art.ts is the single source
// for the art, pixel-art-geometry.ts is the single source for how it becomes
// rects, and this script is the one command that re-applies both. If you change
// either, run this and commit the result.
//
// Replaces only what sits between the two markers in site/index.html; anything
// outside them is left alone.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ART } from "../packages/web/src/components/logo-art.ts";
import {
  CELL_H,
  CELL_W,
  SHADE_OPACITY,
  encode,
} from "../packages/web/src/components/pixel-art-geometry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "site", "index.html");

const BEGIN = "<!-- BEGIN GENERATED WORDMARK — npx tsx scripts/build-site-logo.mjs -->";
const END = "<!-- END GENERATED WORDMARK -->";

const lines = ART.split("\n");
const cols = Math.max(...lines.map((l) => l.length));
const rows = lines.length;
const { solid, shade } = encode(lines);

const rect = (r, extra = "") =>
  `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${CELL_H}"${extra}/>`;

// Shade first so the solid blocks paint over it, matching the component.
const body = [
  ...shade.map((r) => rect(r, ` fill-opacity="${SHADE_OPACITY}"`)),
  ...solid.map((r) => rect(r)),
].join("");

const svg =
  `<svg class="ascii-logo" role="img" aria-label="Demo Locker" ` +
  `viewBox="0 0 ${cols * CELL_W} ${rows * CELL_H}" ` +
  `preserveAspectRatio="xMinYMin meet" shape-rendering="crispEdges">` +
  `<g fill="currentColor">${body}</g></svg>`;

const html = readFileSync(target, "utf8");
const start = html.indexOf(BEGIN);
const stop = html.indexOf(END);
if (start === -1 || stop === -1) {
  throw new Error(`markers not found in ${target} — add ${BEGIN} / ${END}`);
}

const next =
  html.slice(0, start + BEGIN.length) + "\n      " + svg + "\n      " + html.slice(stop);

writeFileSync(target, next);
console.log(
  `wrote ${solid.length + shade.length} rects (${cols}x${rows} cells) into site/index.html`
);
