import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initAccent } from "./lib/theme";

initAccent();

// PWA service worker: production only. In dev the SW's cache-first asset
// strategy would cache Vite's transformed modules, serving stale bundles
// (with the wrong API URL baked in) and wedging the HMR client into an
// error loop that can hang the tab. Dev also unregisters any previously
// installed SW and clears its caches to heal already-affected browsers.
if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register("/sw.js");
  } else {
    navigator.serviceWorker
      .getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()));
    if ("caches" in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
