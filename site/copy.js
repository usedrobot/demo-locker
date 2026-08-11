// Copy-to-clipboard for the prompt blocks.
//
// navigator.clipboard only exists in a secure context. This page is served over
// https so it will normally be there, but the fallback costs four lines and
// means a local `file://` preview still works — the same reasoning as
// packages/web/src/lib/copy-text.ts, which exists because assuming a secure
// context silently broke uploads on a plain-http self-host.
async function copyText(text) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

// The copy button serves whichever install tab is showing. Read at click time,
// not at load: the checked radio is the single source of truth for which
// snippet is on screen, so there is no second piece of state to keep in sync.
const copyBtn = document.getElementById("copy");
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const shown = [...document.querySelectorAll(".prompt-box .panel")].find(
      (p) => getComputedStyle(p).display !== "none"
    );
    if (!shown) return;
    const ok = await copyText(shown.textContent.trim());
    copyBtn.textContent = ok ? "[copied]" : "[copy failed]";
    copyBtn.dataset.copied = String(ok);
    setTimeout(() => {
      copyBtn.textContent = "[copy]";
      delete copyBtn.dataset.copied;
    }, 2000);
  });
}

// Start the demo only when motion is welcome.
//
// `autoplay` is deliberately absent from the markup: with it there, the video
// starts before any script can intervene and stopping it afterwards races the
// browser. Gating the *start* means reduced-motion users and users with no
// JavaScript at all both simply keep the poster frame, from one mechanism
// rather than two.
const demo = document.querySelector(".demo-video");
if (demo) {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sync = () => {
    if (still.matches) {
      demo.pause();
      return;
    }
    demo.play().catch(() => {
      /* refused (battery saver, data saver, no codec) — the poster stands in */
    });
  };
  sync();
  // Honour a change of mind mid-visit; the OS setting can be toggled while the
  // page is open.
  still.addEventListener("change", sync);
}
