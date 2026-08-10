// Geometry for block-glyph art drawn as SVG cells. Kept apart from the
// component so it is directly testable — and because eslint's react-refresh
// rule requires a component file to export only components.
//
// WHY CELLS AT ALL. Drawn as text, this art depends on the space glyph and the
// block glyphs resolving to the same font at the same advance. On mobile they
// do not: at a fractional advance each row lands on its own subpixel boundary
// and the letterforms come apart. Cells on a viewBox have no font and no
// advance, so there is nothing left to drift.
//
// Only three characters ever appear — verified against both logo-art.ts and
// figlet's DOS Rebel output for letters, digits and punctuation: U+0020 space,
// U+2588 FULL BLOCK, U+2591 LIGHT SHADE.

export const SOLID = "█";
export const SHADE = "░";

// One character cell in viewBox units. 61 x 120 reproduces the proportions the
// <pre> had — a 0.61em glyph advance against a 1.2 line-height — so nothing
// about the layout changes. Integers, so every rect edge lands on a whole unit
// and horizontally adjacent runs share an exact boundary with no seam.
export const CELL_W = 61;
export const CELL_H = 120;

// CELL_W as a fraction of the nominal 100-unit font size: the factor that turns
// "cell size in px" into "rendered width in px". The same 0.61 the CSS used.
export const ADVANCE = CELL_W / 100;

// U+2591 is a 25%-density dither of the text colour. At the sizes this art is
// drawn that reads as a flat tint rather than a visible pattern, so a flat tint
// is what we draw — reproducing the dots as an SVG pattern would put a
// sub-pixel grid back into the one thing we moved to vector to get rid of.
export const SHADE_OPACITY = 0.28;

export type Run = { x: number; y: number; w: number };

/**
 * Horizontal run-length encoding, per row, per ink. Two reasons, both real:
 * adjacent cells of one colour become a single rect, so there is no interior
 * edge for the rasteriser to antialias into a visible seam; and the wordmark
 * drops from ~880 rects to 162.
 */
export function encode(lines: string[]): { solid: Run[]; shade: Run[] } {
  const solid: Run[] = [];
  const shade: Run[] = [];

  lines.forEach((line, row) => {
    let ink: string | null = null;
    let start = 0;

    const flush = (end: number) => {
      if (ink === null) return;
      const run = { x: start * CELL_W, y: row * CELL_H, w: (end - start) * CELL_W };
      (ink === SOLID ? solid : shade).push(run);
      ink = null;
    };

    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch !== SOLID && ch !== SHADE) {
        flush(col);
        continue;
      }
      if (ch !== ink) {
        flush(col);
        ink = ch;
        start = col;
      }
    }
    flush(line.length);
  });

  return { solid, shade };
}

/**
 * The CSS `width` for a piece of art `cols` columns wide.
 *
 * Pure so it can be asserted directly. It cannot be tested through the DOM:
 * happy-dom's CSS parser drops any value containing `min()` or `clamp()`, so
 * the rendered style attribute comes back holding only `height`, and a test
 * reading it would measure the test environment rather than this code.
 *
 * Without a floor the art scales down freely — safe here in a way it never was
 * for text, since cells stay exact at any size. With a floor it stops shrinking
 * and overflows instead, which is what lets an over-long page title drift
 * sideways rather than shrink to nothing.
 */
export function widthRule(cols: number, capPx: number, floorPx?: number): string {
  const max = cols * ADVANCE * capPx;
  return floorPx === undefined
    ? `min(100%, ${max}px)`
    : `clamp(${cols * ADVANCE * floorPx}px, 100cqw, ${max}px)`;
}
