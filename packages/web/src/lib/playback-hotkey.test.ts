// @vitest-environment happy-dom
//
// A global Space handler is trivial; knowing when NOT to fire is the whole
// feature. Each of these is a way for "spacebar plays the track" to become
// "typing a space stops the music".
import { describe, it, expect } from "vitest";
import { isPlayPauseKey, type HotkeyEvent } from "./playback-hotkey";

function press(over: Partial<HotkeyEvent> = {}): HotkeyEvent {
  return {
    code: "Space",
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...over,
  };
}

const el = (html: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
};

describe("isPlayPauseKey", () => {
  it("fires on a bare space with nothing focused", () => {
    expect(isPlayPauseKey(press())).toBe(true);
  });

  it("fires when the focus is on ordinary page furniture", () => {
    expect(isPlayPauseKey(press({ target: el("<div>a track row</div>") }))).toBe(true);
  });

  it("ignores every other key", () => {
    expect(isPlayPauseKey(press({ code: "KeyK" }))).toBe(false);
    expect(isPlayPauseKey(press({ code: "Enter" }))).toBe(false);
  });

  it("ignores a held key, so it cannot machine-gun the toggle", () => {
    expect(isPlayPauseKey(press({ repeat: true }))).toBe(false);
  });

  it.each(["metaKey", "ctrlKey", "altKey", "shiftKey"] as const)(
    "leaves %s+Space to the OS and the browser",
    (mod) => {
      expect(isPlayPauseKey(press({ [mod]: true }))).toBe(false);
    }
  );

  // The ones that would actually bite someone.
  it.each([
    ["a rename field", "<input />"],
    ["a comment box", "<textarea></textarea>"],
    ["a select", "<select></select>"],
  ])("does not steal the space someone is typing into %s", (_name, html) => {
    expect(isPlayPauseKey(press({ target: el(html) }))).toBe(false);
  });

  it("does not steal from a contenteditable", () => {
    const node = el("<div contenteditable='true'>typing</div>");
    // happy-dom does not derive isContentEditable from the attribute.
    Object.defineProperty(node, "isContentEditable", { value: true });
    expect(isPlayPauseKey(press({ target: node }))).toBe(false);
  });

  // A focused button already activates on Space natively. Handling it here too
  // toggles twice and cancels out — and the likeliest focused button is the
  // play control, where it looks like the shortcut is simply broken.
  it("defers to a focused button, which activates on Space by itself", () => {
    expect(isPlayPauseKey(press({ target: el("<button>[▶]</button>") }))).toBe(false);
  });

  it("defers when the focus is INSIDE a button", () => {
    const button = el("<button><span>inner</span></button>");
    expect(isPlayPauseKey(press({ target: button.querySelector("span")! }))).toBe(false);
  });

  it("defers to a link and to a role=button", () => {
    expect(isPlayPauseKey(press({ target: el("<a href='#'>x</a>") }))).toBe(false);
    expect(isPlayPauseKey(press({ target: el("<div role='button'>x</div>") }))).toBe(false);
  });
});
