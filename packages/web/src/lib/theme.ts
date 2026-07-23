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
