import { CELL_H, CELL_W, SHADE_OPACITY, encode, widthRule } from "./pixel-art-geometry";

// Renders block-glyph art (the DOS Rebel wordmark and figlet page titles) as
// SVG rectangles instead of text in a <pre>. The reasoning, and the character
// set this handles, live in pixel-art-geometry.ts.
//
// Short version: drawn as text, the art depends on font metrics it cannot
// control, and on mobile the rows drift apart and the letterforms come apart
// with them. The old mitigations — a stacked wordmark, a font-size floor and a
// cap — all amounted to keeping the cell big enough to hide the drift. Cells
// have no font, so there is no drift to hide.

type Props = {
  /** Block-glyph grid, newline separated. */
  art: string;
  /** Accessible name — the actual words the art spells. */
  label: string;
  /** Largest a single cell may render, in px. The old CSS `--cap`. */
  capPx: number;
  /** Smallest a cell may render, in px. The old CSS `--floor`. See widthRule. */
  floorPx?: number;
  className?: string;
  /** Render as a heading at this level rather than as a plain image. */
  headingLevel?: number;
};

export default function PixelArt({
  art,
  label,
  capPx,
  floorPx,
  className,
  headingLevel,
}: Props) {
  const lines = art.split("\n");
  const cols = Math.max(...lines.map((l) => l.length));
  const rows = lines.length;
  const { solid, shade } = encode(lines);

  const a11y =
    headingLevel === undefined
      ? { role: "img" as const }
      : { role: "heading" as const, "aria-level": headingLevel };

  return (
    <svg
      // `display` and `user-select` live in CSS, NOT in the inline style below:
      // an inline display would outrank `.logo-stacked { display: none }` and
      // both wordmark variants would render at once.
      className={className ? `pixel-art ${className}` : "pixel-art"}
      viewBox={`0 0 ${cols * CELL_W} ${rows * CELL_H}`}
      preserveAspectRatio="xMinYMin meet"
      // crispEdges turns off antialiasing on these axis-aligned edges. Without
      // it the boundary between two runs can pick up a half-pixel blend that
      // reads as exactly the seam this component exists to remove.
      shapeRendering="crispEdges"
      aria-label={label}
      style={{ width: widthRule(cols, capPx, floorPx), height: "auto" }}
      {...a11y}
    >
      <g fill="currentColor">
        {shade.map((r, i) => (
          <rect
            key={`s${i}`}
            x={r.x}
            y={r.y}
            width={r.w}
            height={CELL_H}
            fillOpacity={SHADE_OPACITY}
          />
        ))}
        {solid.map((r, i) => (
          <rect key={`f${i}`} x={r.x} y={r.y} width={r.w} height={CELL_H} />
        ))}
      </g>
    </svg>
  );
}
