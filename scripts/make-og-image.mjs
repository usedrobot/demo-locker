#!/usr/bin/env node
// Generates the social preview card (og.png) for both surfaces.
//
// The paths are READ from packages/web/public/logo-mark.svg rather than copied
// here, so the card cannot drift from the real mark the way a pasted duplicate
// would. Re-run this after any change to the mark.
//
//   node scripts/make-og-image.mjs
//
// 1200x630 is the size Open Graph consumers crop against; anything smaller gets
// upscaled and the block edges of the waveform go soft. Amber on the same
// #0a0a0a plate as favicon.svg, because a link preview has no page around it to
// inherit currentColor from — the same reason the favicon carries a plate.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markPath = resolve(root, "packages/web/public/logo-mark.svg");

const mark = readFileSync(markPath, "utf8");
const paths = [...mark.matchAll(/<path\b[^>]*\/>/g)].map((m) => m[0]);
if (paths.length !== 2) {
  throw new Error(
    `expected 2 paths in ${markPath}, found ${paths.length} — the mark changed shape, check this script still centres it`,
  );
}

const W = 1200;
const H = 630;
const MARK_UNITS = 32; // logo-mark.svg viewBox
// Sized by looking at the result, not by picking a round number: at 300 the
// mark floated in the middle of a mostly empty card, and consumers shrink the
// card further in a feed. 380 fills the frame without crowding the edges.
const TARGET = 380;
const scale = TARGET / MARK_UNITS;
const x = (W - TARGET) / 2;
const y = (H - TARGET) / 2;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0a0a0a"/>
  <g transform="translate(${x} ${y}) scale(${scale})" fill="#fc0">
    ${paths.join("\n    ")}
  </g>
</svg>`;

const outputs = [
  resolve(root, "packages/web/public/og.png"),
  resolve(root, "site/img/og.png"),
];

for (const out of outputs) {
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`wrote ${out.replace(root + "/", "")}`);
}
