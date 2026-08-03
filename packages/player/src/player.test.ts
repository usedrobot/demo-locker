import { describe, expect, test } from "vitest";
import { DemoLockerPlayer } from "./player";

describe("@demo-locker/player module", () => {
  test("importing the module registers the custom element", () => {
    expect(customElements.get("demo-locker-player")).toBe(DemoLockerPlayer);
  });

  test("createElement produces an instance of the exported class", () => {
    const el = document.createElement("demo-locker-player");
    expect(el).toBeInstanceOf(DemoLockerPlayer);
    expect(el).toBeInstanceOf(HTMLElement);
  });

  test("re-importing the module does not throw (define guard)", async () => {
    await expect(import("./player")).resolves.toBeDefined();
  });

  // The now-playing title lives in a child of .now, not in .now itself: .now is
  // the clipping box and the query container, and the child is what drifts when
  // the title is wider than the box. Writing textContent onto .now instead would
  // delete that child, and the title would silently stop moving — it would still
  // *look* fine at desktop widths, where nothing overflows.
  test("the transport title renders into .now-text, inside .now", async () => {
    const el = document.createElement("demo-locker-player") as InstanceType<typeof DemoLockerPlayer>;
    document.body.appendChild(el);
    // Drive render() without a network fetch by handing it a playlist directly.
    (el as unknown as { data: unknown }).data = {
      id: "p1",
      name: "Test",
      tracks: [{ id: "t1", title: "A Very Long Track Title", duration: 100 }],
    };
    (el as unknown as { current: number }).current = 0;
    (el as unknown as { render: () => void }).render();

    const now = el.shadowRoot!.querySelector(".now")!;
    const text = el.shadowRoot!.querySelector(".now-text")!;
    expect(now).toBeTruthy();
    expect(text).toBeTruthy();
    expect(text.parentElement).toBe(now);
    expect(text.textContent).toContain("A Very Long Track Title");
    // The box must not carry the text directly, or the child was clobbered.
    expect(now.childElementCount).toBe(1);

    el.remove();
  });
});
