// Accent color theming. The whole UI keys off the --accent / --accent-dim CSS
// variables, so switching accents is just swapping those two values.

export const ACCENTS = [
  "#fc0", // gold
  "#f80", // amber
  "#4af", // blue
  "#3f6", // green
  "#f6a", // pink
  "#a6f", // purple
  "#6cf", // cyan
];

const STORAGE_KEY = "accent";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

export function getAccent(): string {
  return localStorage.getItem(STORAGE_KEY) || ACCENTS[0];
}

export function applyAccent(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty("--accent", hex);
  root.style.setProperty("--accent-dim", `rgba(${r}, ${g}, ${b}, 0.08)`);
}

export function setAccent(hex: string) {
  localStorage.setItem(STORAGE_KEY, hex);
  applyAccent(hex);
}

export function cycleAccent(): string {
  const idx = ACCENTS.indexOf(getAccent());
  const next = ACCENTS[(idx + 1) % ACCENTS.length];
  setAccent(next);
  return next;
}

export function initAccent() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) applyAccent(stored);
}

// The owner's accent is stored on their account, so it can arrive after first
// paint (from /auth/me) or belong to someone else entirely (a share link, where
// the listener sees the owner's colour). localStorage stays the fast path for
// the owner's own browser; the server is the source of truth.
export function adoptAccent(hex: string | null | undefined) {
  if (!hex || !ACCENTS.includes(hex)) return;
  localStorage.setItem(STORAGE_KEY, hex);
  applyAccent(hex);
}

// Show someone else's accent for the life of a view without adopting it as this
// browser's setting. Returns a restore function for unmount — otherwise a
// listener who also owns a locker keeps whatever colour the last invite used.
export function previewAccent(hex: string | null | undefined): () => void {
  const previous = getAccent();
  if (hex && ACCENTS.includes(hex)) applyAccent(hex);
  return () => applyAccent(previous);
}
