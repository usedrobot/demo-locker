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

// Plays are reported to the instance's public plays route once per track
// start — on the first `playing` after a fresh src, never on resume — so the
// locker's per-playlist counts include embed listeners. The CORS-retry path
// reassigns the same src; that is the same listen and must not report twice.
describe("play reporting", () => {
  function mount() {
    const el = document.createElement("demo-locker-player") as InstanceType<typeof DemoLockerPlayer>;
    el.setAttribute("instance", "https://locker.example");
    document.body.appendChild(el);
    (el as unknown as { data: unknown }).data = {
      id: "p1",
      name: "Test",
      tracks: [
        { id: "t1", title: "One", duration: 10 },
        { id: "t2", title: "Two", duration: 10 },
      ],
    };
    (el as unknown as { render: () => void }).render();
    return el;
  }
  function audioOf(el: HTMLElement): HTMLAudioElement {
    return (el as unknown as { audio: HTMLAudioElement }).audio;
  }
  function playIndex(el: HTMLElement, i: number) {
    (el as unknown as { play: (i: number) => void }).play(i);
  }
  function fetchMock() {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch;
    return calls;
  }

  test("posts one play against the playlist when a track starts", () => {
    const calls = fetchMock();
    const el = mount();
    playIndex(el, 0);
    audioOf(el).dispatchEvent(new Event("playing"));
    audioOf(el).dispatchEvent(new Event("playing"));
    expect(calls).toEqual([
      { url: "https://locker.example/public/v1/tracks/t1/plays", body: { playlistId: "p1" } },
    ]);
  });

  test("resume after pause is not a new play; the next track is", () => {
    const calls = fetchMock();
    const el = mount();
    playIndex(el, 0);
    audioOf(el).dispatchEvent(new Event("playing"));
    playIndex(el, 0); // toggles pause
    playIndex(el, 0); // resumes
    audioOf(el).dispatchEvent(new Event("playing"));
    playIndex(el, 1);
    audioOf(el).dispatchEvent(new Event("playing"));
    expect(calls.map((c) => c.url)).toEqual([
      "https://locker.example/public/v1/tracks/t1/plays",
      "https://locker.example/public/v1/tracks/t2/plays",
    ]);
  });

  test("a failed report is swallowed", () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const el = mount();
    playIndex(el, 0);
    expect(() => audioOf(el).dispatchEvent(new Event("playing"))).not.toThrow();
  });
});
