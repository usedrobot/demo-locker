// <demo-locker-player playlist="..." [instance="https://your-box"]>
// Zero-dependency web component. Fetches /public/v1 metadata and streams audio.
// Theming: every visual value is a --dl-* custom property; structural nodes
// carry part="" attributes for ::part() styling.

type Track = { id: string; title: string; duration: number | null };
type PlaylistData = {
  id: string;
  name: string;
  artworkUrl: string | null;
  tracks: Track[];
};

// Origin of the script that loaded us — the default instance.
const SCRIPT_ORIGIN = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    return src ? new URL(src).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
})();

function formatTime(secs: number | null): string {
  if (secs == null || !isFinite(secs)) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const STYLES = `
:host {
  --dl-bg: #0d0d0d;
  --dl-fg: #d8d8d8;
  --dl-accent: #5fd75f;
  --dl-muted: #6b6b6b;
  --dl-border: #2e2e2e;
  --dl-font: "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --dl-font-size: 13px;
  --dl-radius: 0;
  --dl-padding: 12px;
  display: block;
  background: var(--dl-bg);
  color: var(--dl-fg);
  font-family: var(--dl-font);
  font-size: var(--dl-font-size);
  border: 1px solid var(--dl-border);
  border-radius: var(--dl-radius);
  max-width: 100%;
}
* { box-sizing: border-box; }
.header { display: flex; gap: var(--dl-padding); padding: var(--dl-padding); border-bottom: 1px solid var(--dl-border); align-items: center; }
.artwork { width: 64px; height: 64px; object-fit: cover; border: 1px solid var(--dl-border); flex: none; }
.artwork.empty { display: flex; align-items: center; justify-content: center; color: var(--dl-muted); }
.title { font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transport { display: flex; align-items: center; gap: 8px; padding: 8px var(--dl-padding); border-bottom: 1px solid var(--dl-border); }
button { background: none; border: 1px solid var(--dl-border); color: var(--dl-fg); font: inherit; cursor: pointer; padding: 2px 8px; }
button:hover { border-color: var(--dl-accent); color: var(--dl-accent); }
.time { color: var(--dl-muted); font-size: 0.9em; white-space: nowrap; }
.seek { flex: 1; appearance: none; height: 4px; background: var(--dl-border); cursor: pointer; }
.seek::-webkit-slider-thumb { appearance: none; width: 10px; height: 14px; background: var(--dl-accent); }
.seek::-moz-range-thumb { width: 10px; height: 14px; background: var(--dl-accent); border: none; border-radius: 0; }
.tracks { list-style: none; margin: 0; padding: 4px 0; max-height: 240px; overflow-y: auto; }
.tracks li { display: flex; justify-content: space-between; gap: 8px; padding: 4px var(--dl-padding); cursor: pointer; }
.tracks li:hover { color: var(--dl-accent); }
.tracks li.active { color: var(--dl-accent); }
.tracks li .dur { color: var(--dl-muted); }
.status { padding: var(--dl-padding); color: var(--dl-muted); }
.footer { padding: 4px var(--dl-padding); border-top: 1px solid var(--dl-border); font-size: 0.85em; }
.footer a { color: var(--dl-muted); text-decoration: none; }
.footer a:hover { color: var(--dl-accent); }
`;

class DemoLockerPlayer extends HTMLElement {
  private shadow: ShadowRoot;
  private audio = new Audio();
  private data: PlaylistData | null = null;
  private current = -1;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.audio.preload = "none";
    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("timeupdate", () => this.updateTime());
    this.audio.addEventListener("play", () => this.render());
    this.audio.addEventListener("pause", () => this.render());
  }

  get instance(): string {
    return this.getAttribute("instance") || SCRIPT_ORIGIN;
  }

  async connectedCallback() {
    const playlistId = this.getAttribute("playlist");
    if (!playlistId) {
      this.renderStatus("demo-locker-player: missing playlist attribute");
      return;
    }
    this.renderStatus("loading…");
    try {
      const res = await fetch(`${this.instance}/public/v1/playlists/${encodeURIComponent(playlistId)}`);
      if (!res.ok) throw new Error(String(res.status));
      this.data = (await res.json()).playlist;
      this.render();
    } catch {
      this.renderStatus("playlist unavailable");
    }
  }

  disconnectedCallback() {
    this.audio.pause();
  }

  private streamUrl(trackId: string): string {
    return `${this.instance}/public/v1/tracks/${encodeURIComponent(trackId)}/stream`;
  }

  private play(index: number) {
    if (!this.data || !this.data.tracks[index]) return;
    if (this.current === index) {
      if (this.audio.paused) {
        this.audio.play().catch(() => {
          /* autoplay blocked or load error — transport stays paused */
        });
      } else this.audio.pause();
      return;
    }
    this.current = index;
    this.audio.src = this.streamUrl(this.data.tracks[index].id);
    this.audio.play().catch(() => {
      /* autoplay blocked or load error — transport stays paused */
    });
    this.render();
  }

  private next() {
    if (!this.data) return;
    if (this.current + 1 < this.data.tracks.length) this.play(this.current + 1);
    else this.render();
  }

  private prev() {
    if (this.current > 0) this.play(this.current - 1);
  }

  private updateTime() {
    const time = this.shadow.querySelector(".time");
    const seek = this.shadow.querySelector<HTMLInputElement>(".seek");
    if (time) {
      const duration =
        Number.isFinite(this.audio.duration) && this.audio.duration > 0
          ? this.audio.duration
          : (this.data?.tracks[this.current]?.duration ?? null);
      time.textContent = `${formatTime(this.audio.currentTime)} / ${formatTime(duration)}`;
    }
    if (seek && this.audio.duration) {
      seek.value = String((this.audio.currentTime / this.audio.duration) * 100);
    }
  }

  private renderStatus(msg: string) {
    this.shadow.innerHTML = `<style>${STYLES}</style><div class="status" part="status"></div>`;
    this.shadow.querySelector(".status")!.textContent = msg;
  }

  private render() {
    if (!this.data) return;
    const playing = this.current >= 0 && !this.audio.paused;

    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="header" part="header">
        <div class="artwork-slot"></div>
        <div class="title" part="title"></div>
      </div>
      <div class="transport" part="transport">
        <button class="prev" part="button">|◀</button>
        <button class="toggle" part="button">${playing ? "❚❚" : "▶"}</button>
        <button class="nextb" part="button">▶|</button>
        <input class="seek" part="seek" type="range" min="0" max="100" value="0">
        <span class="time" part="time">--:-- / --:--</span>
      </div>
      <ul class="tracks" part="tracklist"></ul>
      <div class="footer" part="footer"><a href="https://github.com/usedrobot/demo-locker" target="_blank" rel="noopener">demo locker</a></div>
    `;

    const slot = this.shadow.querySelector(".artwork-slot")!;
    if (this.data.artworkUrl) {
      const img = document.createElement("img");
      img.className = "artwork";
      img.setAttribute("part", "artwork");
      img.alt = "";
      img.src = new URL(this.data.artworkUrl, this.instance).href;
      slot.replaceWith(img);
    } else {
      const empty = document.createElement("div");
      empty.className = "artwork empty";
      empty.setAttribute("part", "artwork");
      empty.textContent = "♫";
      slot.replaceWith(empty);
    }

    this.shadow.querySelector(".title")!.textContent = this.data.name;

    const list = this.shadow.querySelector(".tracks")!;
    this.data.tracks.forEach((t, i) => {
      const li = document.createElement("li");
      li.setAttribute("part", "track");
      if (i === this.current) li.classList.add("active");
      const name = document.createElement("span");
      name.textContent = `${i === this.current && playing ? "▶ " : ""}${t.title}`;
      const dur = document.createElement("span");
      dur.className = "dur";
      dur.textContent = formatTime(t.duration);
      li.append(name, dur);
      li.addEventListener("click", () => this.play(i));
      list.appendChild(li);
    });

    this.shadow.querySelector(".toggle")!.addEventListener("click", () => {
      if (this.current < 0) this.play(0);
      else this.play(this.current);
    });
    this.shadow.querySelector(".prev")!.addEventListener("click", () => this.prev());
    this.shadow.querySelector(".nextb")!.addEventListener("click", () => this.next());
    this.shadow.querySelector<HTMLInputElement>(".seek")!.addEventListener("input", (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (this.audio.duration) this.audio.currentTime = (v / 100) * this.audio.duration;
    });

    this.updateTime();
  }
}

if (!customElements.get("demo-locker-player")) {
  customElements.define("demo-locker-player", DemoLockerPlayer);
}
