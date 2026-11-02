// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Track } from "../lib/api";

vi.mock("../lib/download-all", () => ({
  buildPlaylistZip: vi.fn(),
  saveBlob: vi.fn(),
  zipFileName: (n: string) => `${n}.zip`,
}));

import DownloadAllButton from "./DownloadAllButton";
import { buildPlaylistZip, saveBlob } from "../lib/download-all";

const build = vi.mocked(buildPlaylistZip);
const save = vi.mocked(saveBlob);
const list = [{ id: "a", title: "A" }, { id: "b", title: "B" }] as unknown as Track[];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(tracks: Track[] = list) {
  act(() => root.render(<DownloadAllButton tracks={tracks} playlistName="Slack Tide" />));
}
const button = () => container.querySelector("button");

describe("DownloadAllButton", () => {
  it("renders nothing for an empty playlist", () => {
    render([]);
    expect(button()).toBeNull();
  });

  it("zips the playlist in order and saves it under the playlist's name", async () => {
    const blob = new Blob(["zip"]);
    build.mockResolvedValue(blob);
    render();
    await act(async () => button()!.click());
    expect(build).toHaveBeenCalledWith(list, expect.any(Function));
    expect(save).toHaveBeenCalledWith(blob, "Slack Tide.zip");
  });

  it("shows progress and cannot be started twice while zipping", async () => {
    let finish!: (b: Blob) => void;
    build.mockImplementation((_t, onProgress) => {
      onProgress?.(1, 2);
      return new Promise((r) => (finish = r));
    });
    render();
    await act(async () => button()!.click());
    expect(button()!.textContent).toBe("[zipping 1/2…]");
    expect(button()!.disabled).toBe(true);
    await act(async () => finish(new Blob(["z"])));
    expect(button()!.textContent).toBe("[↓ all]");
    expect(button()!.disabled).toBe(false);
  });

  it("says which track failed instead of saving a partial zip", async () => {
    build.mockRejectedValue(new Error(`couldn't download "B" (404)`));
    render();
    await act(async () => button()!.click());
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(`"B"`);
  });
});
