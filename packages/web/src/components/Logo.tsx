import { ART, ART_STACKED } from "./logo-art";
import PixelArt from "./PixelArt";

// Both variants render and the breakpoint picks one, rather than measuring a
// width in JS. Same reasoning as before: CSS re-solves on rotate and resize for
// free, with no listener and no first-paint flash of the wrong variant.
//
// The breakpoint now exists for LEGIBILITY only. It used to be load bearing:
// the one-line mark is 110 columns, which on a phone drove the glyph cell down
// to ~3.2px, and below about 5px the block characters stopped tiling and the
// letterforms came apart. Drawn as cells (PixelArt) there is no tiling to fail,
// so the stacked mark is now a choice about how bold the wordmark reads on a
// narrow screen, not a workaround. Deleting it would be a design decision, not
// a bug fix.
export default function Logo() {
  return (
    <div className="ascii-fit">
      <PixelArt className="logo-wide" art={ART} label="Demo Locker" capPx={11} />
      <PixelArt className="logo-stacked" art={ART_STACKED} label="Demo Locker" capPx={8} />
    </div>
  );
}
