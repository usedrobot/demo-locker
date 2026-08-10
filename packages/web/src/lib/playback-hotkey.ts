// Should this keypress toggle playback?
//
// Pulled out of the Player's window listener so the guards can be tested
// directly. They ARE the feature: a global Space handler is two lines, and
// every difficult part is deciding when NOT to fire. Getting that wrong means
// someone types a space into a comment and the music stops.

/** The parts of a KeyboardEvent this decision needs. */
export type HotkeyEvent = {
  code: string;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
};

export function isPlayPauseKey(e: HotkeyEvent): boolean {
  if (e.code !== "Space") return false;

  // Holding the key down would otherwise machine-gun play/pause.
  if (e.repeat) return false;

  // Cmd/Ctrl/Alt+Space belong to the OS and to browser shortcuts.
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;

  const target = e.target as HTMLElement | null;
  if (!target || typeof target.tagName !== "string") return true;

  // Text entry keeps its spaces. This app has rename fields, comment boxes, a
  // display-name field and a password form; without this, every one of them
  // swallows the space and stops the music instead.
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (target.isContentEditable) return false;

  // A focused button or link ALREADY activates on Space natively. Handling it
  // here as well toggles twice, which cancels out — and the most likely element
  // to be focused is the play button itself, where it looks like the shortcut
  // simply does not work.
  if (typeof target.closest === "function" && target.closest("button, a, [role='button']")) {
    return false;
  }

  return true;
}
