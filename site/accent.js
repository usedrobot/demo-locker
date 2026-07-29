// Accent theming for the brochure, ported from packages/web/src/lib/theme.ts.
// Same list, same two CSS variables — the page and the app should be able to
// wear the same color. Two deliberate differences from the app: the brochure
// picks a random accent per load instead of reading localStorage (nothing here
// is a persistent workspace, and a different color each visit is the point),
// and clicking the swatch cycles for the session only.
//
// Loaded synchronously in <head>, not deferred: a deferred script applies the
// accent after first paint, so the page would flash gold before landing on its
// real color. The click handler is delegated off `document` because the swatch
// itself hasn't been parsed yet at this point.
(function () {
  var ACCENTS = [
    "#fc0", // gold
    "#f80", // amber
    "#4af", // blue
    "#3f6", // green
    "#f6a", // pink
    "#a6f", // purple
    "#6cf", // cyan
  ];

  function apply(hex) {
    // every accent above is 3-digit shorthand, so expanding it is the whole job
    // here, not an edge case — reading pairs straight off "#fc0" yields NaN for
    // blue and kills --accent-dim silently, since an invalid custom property
    // just makes the tinted prompt boxes transparent.
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    var root = document.documentElement;
    root.style.setProperty("--accent", hex);
    root.style.setProperty("--accent-dim", "rgba(" + r + ", " + g + ", " + b + ", 0.08)");
  }

  var current = Math.floor(Math.random() * ACCENTS.length);
  apply(ACCENTS[current]);

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".accent-swatch");
    if (!btn) return;
    current = (current + 1) % ACCENTS.length;
    apply(ACCENTS[current]);
  });
})();
