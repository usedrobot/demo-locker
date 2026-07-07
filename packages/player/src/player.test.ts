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
});
