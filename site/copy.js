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

for (const btn of document.querySelectorAll(".btn[data-target]")) {
  btn.addEventListener("click", async () => {
    const source = document.getElementById(btn.dataset.target);
    if (!source) return;
    const ok = await copyText(source.textContent.trim());
    btn.textContent = ok ? "[copied]" : "[copy failed]";
    btn.dataset.copied = String(ok);
    setTimeout(() => {
      btn.textContent = "[copy]";
      delete btn.dataset.copied;
    }, 2000);
  });
}
