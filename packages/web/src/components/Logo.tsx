import { ART, ART_STACKED } from "./logo-art";

// Both variants render and the breakpoint picks one, rather than measuring a
// width in JS. Same reasoning as the font-size clamp in index.css: CSS
// re-solves on rotate and resize for free, with no listener and no first-paint
// flash of the wrong variant.
export default function Logo() {
  return (
    <div className="ascii-fit">
      <pre className="ascii-logo logo-wide" role="img" aria-label="Demo Locker">
        {ART}
      </pre>
      <pre className="ascii-logo logo-stacked" role="img" aria-label="Demo Locker">
        {ART_STACKED}
      </pre>
    </div>
  );
}
