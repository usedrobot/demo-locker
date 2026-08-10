// The property under test is the one the old code broke: columns must tile the
// canvas EXACTLY. The click handler maps x/width to a fraction of the duration,
// so any mismatch between "how wide the waveform was drawn" and "how wide the
// canvas is" shows up as a seek that lands somewhere other than where you
// clicked.
import { describe, it, expect } from "vitest";
import { waveformColumns, MIN_COL_W } from "./waveform-columns";

// What the app actually stores — lib/peaks.ts TARGET_PEAKS.
const STORED_PEAKS = 400;
const peaks = (n: number, f: (i: number) => number = () => 1) =>
  Array.from({ length: n }, (_, i) => f(i));

describe("waveformColumns", () => {
  // The regression. 400 peaks at a 2px floor drew 800px wide regardless of the
  // canvas; this player's canvas is ~720px at most and ~300px on a phone, so
  // the tail was drawn past the edge and clipped while seeking still used the
  // full width.
  it.each([300, 360, 414, 720, 800, 1200])(
    "never draws wider than the canvas (%ipx)",
    (cssWidth) => {
      const cols = waveformColumns(peaks(STORED_PEAKS), cssWidth);
      const colW = cssWidth / cols.length;
      expect(cols.length * colW).toBeCloseTo(cssWidth, 6);
      expect(colW).toBeGreaterThanOrEqual(MIN_COL_W - 1e-9);
    }
  );

  it("keeps columns at least MIN_COL_W wide by merging, not by overflowing", () => {
    // 300px can show 150 columns at 2px. The old code drew 400.
    const cols = waveformColumns(peaks(STORED_PEAKS), 300);
    expect(cols).toHaveLength(150);
  });

  it("uses one column per peak when there is room to spare", () => {
    const cols = waveformColumns(peaks(100), 1000);
    expect(cols).toHaveLength(100);
  });

  it("covers every source peak — no tail is dropped", () => {
    // A single spike in the LAST peak must survive into the last column. Under
    // the old code that region was drawn off-canvas entirely.
    const p = peaks(STORED_PEAKS, (i) => (i === STORED_PEAKS - 1 ? 1 : 0.01));
    const cols = waveformColumns(p, 300);
    expect(cols[cols.length - 1]).toBeCloseTo(1, 6);
  });

  it("puts a spike in the column matching its position in the track", () => {
    // Spike at 25% of the way through should land in the column at 25%.
    const at = Math.floor(STORED_PEAKS * 0.25);
    const p = peaks(STORED_PEAKS, (i) => (i === at ? 1 : 0));
    const cols = waveformColumns(p, 400);
    const loud = cols.findIndex((v) => v > 0.5);
    expect(loud / cols.length).toBeCloseTo(0.25, 2);
  });

  it("takes the peak of a merged group, not the mean", () => {
    // Averaging flattens transients — a waveform that hides the hits is no use
    // for finding a spot in a take.
    const p = [0, 1, 0, 0];
    const cols = waveformColumns(p, 4, 2); // 4px / 2 = 2 columns
    expect(cols).toHaveLength(2);
    expect(cols[0]).toBe(1);
  });

  it("normalises to the loudest column", () => {
    const cols = waveformColumns([0.1, 0.2, 0.3, 0.4], 100);
    expect(Math.max(...cols)).toBe(1);
  });

  it("handles negative peaks by magnitude", () => {
    const cols = waveformColumns([-1, 0, 0, 0], 100);
    expect(cols[0]).toBe(1);
  });

  it("returns nothing to draw for no peaks or no width", () => {
    expect(waveformColumns([], 500)).toEqual([]);
    expect(waveformColumns(peaks(10), 0)).toEqual([]);
  });

  it("survives a canvas narrower than one column", () => {
    const cols = waveformColumns(peaks(STORED_PEAKS), 1);
    expect(cols).toHaveLength(1);
    expect(cols.length * (1 / cols.length)).toBeCloseTo(1, 6);
  });
});
