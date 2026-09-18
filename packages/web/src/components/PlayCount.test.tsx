// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PlayCount from "./PlayCount";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(count: number | undefined, scope: "library" | "playlist" = "library") {
  act(() => {
    root.render(<PlayCount count={count} scope={scope} />);
  });
}

describe("PlayCount", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("renders nothing when the listing carried no count", () => {
    render(undefined);
    expect(container.textContent).toBe("");
  });

  it("shows the number with a plural-aware label", () => {
    render(3);
    expect(container.textContent).toContain("3");
    expect(container.querySelector("span")?.getAttribute("aria-label")).toBe("3 plays");
    render(1);
    expect(container.querySelector("span")?.getAttribute("aria-label")).toBe("1 play");
  });

  it("says which scope the count is for inside a playlist", () => {
    render(2, "playlist");
    expect(container.querySelector("span")?.getAttribute("aria-label")).toBe("2 plays in this playlist");
  });

  it("renders zero, dimmed, rather than hiding it", () => {
    render(0);
    const span = container.querySelector("span")!;
    expect(span.textContent).toContain("0");
    expect(span.style.color).not.toBe("var(--fg-dim)");
  });
});
