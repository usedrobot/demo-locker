// Turn N stored peaks into exactly as many drawable columns as the canvas can
// hold, so the waveform tiles the canvas EXACTLY.
//
// WHY THIS EXISTS. The drawing loop used to be:
//
//   const colW = Math.max(cssWidth / peaks.length, 2);
//   for (let i = 0; i < peaks.length; i++) { const x = i * colW; ... }
//
// with a fixed 400 stored peaks. That `Math.max(…, 2)` floor stops a column
// vanishing when there is less than a pixel of room for it — but it also means
// the loop draws `peaks.length * 2` pixels wide regardless of the canvas. At
// 400 peaks that is 800px, and this player's canvas is NEVER that wide: the
// bar is capped at 880px with 1.5rem padding and a 96px artwork tile, so ~720px
// on a desktop and ~300px on a phone. The rest of the waveform was drawn past
// the right edge and clipped.
//
// The click handler, meanwhile, always mapped the full canvas width to the full
// duration. So the picture and the seek disagreed — by ~10% at the right-hand
// end on a desktop, and by up to ~60% on a phone, which is why tapping was
// worse than clicking.
//
// Fixing it by removing the floor alone would make sub-pixel columns disappear.
// Instead: pick a column count the canvas can actually show, and aggregate the
// peaks into it. Columns then tile the width exactly, so a click at x lands on
// the same fraction of the track that the bar under x was drawn from.
//
// packages/player/src/player.ts carries the same logic for the embed. It is a
// separately published package with no shared module to import from, so the two
// are duplicated deliberately — change one, change the other.

/** Narrowest a column may be drawn, in CSS px, before columns are merged. */
export const MIN_COL_W = 2;

/**
 * Peak magnitude per drawn column, already normalised to 0..1.
 *
 * The returned length is what the caller must loop over — NOT peaks.length —
 * and `cssWidth / result.length` is the exact column width.
 */
export function waveformColumns(
  peaks: number[],
  cssWidth: number,
  minColW: number = MIN_COL_W
): number[] {
  if (peaks.length === 0 || cssWidth <= 0) return [];

  // Never more columns than the canvas can show, never more than we have data
  // for, never fewer than one.
  const cols = Math.max(1, Math.min(peaks.length, Math.floor(cssWidth / minColW)));

  const out: number[] = new Array(cols);
  let max = 0;

  for (let j = 0; j < cols; j++) {
    // Half-open [start, end) over the source peaks. Computed from j rather than
    // by accumulating a step, so rounding cannot drift and the last column
    // always ends exactly at peaks.length.
    const start = Math.floor((j * peaks.length) / cols);
    const end = Math.max(start + 1, Math.floor(((j + 1) * peaks.length) / cols));

    // Peak, not mean: averaging flattens transients, and a waveform that does
    // not show the hits is not much use for finding a spot in a take.
    let peak = 0;
    for (let k = start; k < end && k < peaks.length; k++) {
      const v = Math.abs(peaks[k]);
      if (v > peak) peak = v;
    }
    out[j] = peak;
    if (peak > max) max = peak;
  }

  // Normalise against the loudest COLUMN rather than the loudest sample, so the
  // drawn shape fills the height the same way it did before this change.
  if (max > 0) {
    for (let j = 0; j < cols; j++) out[j] /= max;
  }
  return out;
}
