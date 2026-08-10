// @vitest-environment happy-dom
//
// The wordmark and the page titles used to be block characters in a <pre>, so
// they depended on the space glyph and the block glyphs resolving to one font
// at one advance. On mobile they do not: rows land on different subpixel
// boundaries and the letterforms come apart. These assertions are about the
// art being geometry rather than text, because "it looks fine on my laptop" is
// exactly what kept the old version in place.
//
// What a test can prove here is the conversion — that ink lands in the right
// cells, that runs merge, and that nothing font-dependent survives. Whether it
// LOOKS right is a rasteriser question and was checked by rendering it, not
// here.
import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PixelArt from "./PixelArt";
import { widthRule } from "./pixel-art-geometry";

const CELL_W = 61;
const CELL_H = 120;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
}

function rects() {
  return Array.from(container.querySelectorAll("rect"));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

describe("PixelArt", () => {
  it("draws nothing for a space and one rect per ink run", () => {
    // row 0: two solid, a gap, one solid   row 1: three shade
    render(<PixelArt art={"██ █\n░░░"} label="x" capPx={8} />);

    const r = rects();
    // 2 solid runs + 1 shade run
    expect(r).toHaveLength(3);
  });

  it("merges a horizontal run into a single rect rather than one per cell", () => {
    render(<PixelArt art={"████"} label="x" capPx={8} />);

    const r = rects();
    expect(r).toHaveLength(1);
    expect(r[0].getAttribute("x")).toBe("0");
    expect(r[0].getAttribute("width")).toBe(String(4 * CELL_W));
  });

  it("places ink in the cell its column and row say", () => {
    render(<PixelArt art={"  ██\n█"} label="x" capPx={8} />);

    const r = rects();
    const top = r.find((n) => n.getAttribute("y") === "0")!;
    const below = r.find((n) => n.getAttribute("y") === String(CELL_H))!;

    expect(top.getAttribute("x")).toBe(String(2 * CELL_W));
    expect(top.getAttribute("width")).toBe(String(2 * CELL_W));
    expect(below.getAttribute("x")).toBe("0");
  });

  it("does not break a run across two inks", () => {
    render(<PixelArt art={"██░░"} label="x" capPx={8} />);

    const r = rects();
    expect(r).toHaveLength(2);
    // Shade is drawn first so solid sits on top; assert by opacity, not order.
    const shade = r.find((n) => n.getAttribute("fill-opacity") !== null)!;
    const solid = r.find((n) => n.getAttribute("fill-opacity") === null)!;
    expect(solid.getAttribute("x")).toBe("0");
    expect(shade.getAttribute("x")).toBe(String(2 * CELL_W));
  });

  it("sizes the viewBox from the widest row, not the first", () => {
    render(<PixelArt art={"█\n█████"} label="x" capPx={8} />);

    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${5 * CELL_W} ${2 * CELL_H}`);
  });

  it("carries the words as an accessible name and no renderable text", () => {
    render(<PixelArt art={"██\n░░"} label="Demo Locker" capPx={8} />);

    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toBe("Demo Locker");
    expect(svg.getAttribute("role")).toBe("img");
    // The whole point: nothing here is text, so no font can move it.
    expect(container.textContent).toBe("");
  });

  it("is a heading when asked, so a page title still reads as one", () => {
    render(<PixelArt art={"██"} label="FC 7.29.26" capPx={8} headingLevel={2} />);

    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("heading");
    expect(svg.getAttribute("aria-level")).toBe("2");
  });

  it("keeps display in CSS, not inline — an inline one would show both wordmarks", () => {
    // .logo-stacked { display: none } and .pixel-art { display: block } are
    // both single-class selectors, so an inline display would outrank the
    // media query that hides one variant and both would render at once.
    render(<PixelArt art={"██"} label="x" capPx={8} className="logo-stacked" />);

    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("style")).not.toContain("display");
    expect(svg.getAttribute("class")).toBe("pixel-art logo-stacked");
  });

});

// Asserted against widthRule directly, NOT by reading the rendered style
// attribute. happy-dom's CSS parser drops any value containing min() or
// clamp(), so the attribute comes back with only `height: auto` and a DOM
// assertion here would pass or fail on the test environment's CSS support
// rather than on this component. The rendered result was checked in a real
// browser instead.
describe("PixelArt — width", () => {
  it("scales with the container but never past the cap", () => {
    // 4 cols * 0.61 advance * 8px cap = 19.52px
    expect(widthRule(4, 8)).toBe("min(100%, 19.52px)");
  });

  it("stops shrinking at the floor so a long title drifts instead", () => {
    const rule = widthRule(4, 8, 7);
    expect(rule).toBe("clamp(17.08px, 100cqw, 19.52px)");
  });

  it("scales the cap with the column count", () => {
    // The wordmark: 110 columns at an 11px cap.
    expect(widthRule(110, 11)).toBe(`min(100%, ${110 * 0.61 * 11}px)`);
  });
});
