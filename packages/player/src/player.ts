// <demo-locker-player playlist="..." [instance="https://your-box"]>
// Zero-dependency web component. Fetches /public/v1 metadata and streams audio.
// Theming: every visual value is a --dl-* custom property; structural nodes
// carry part="" attributes for ::part() styling.
//
// TUI look (cliamp-inspired): bracket-key transport, ●/■ status, ♫ title,
// segmented LED-cell waveform (click to seek), live block-character spectrum
// driven by a Web Audio analyser when the stream is CORS-readable.

type Track = {
  id: string;
  title: string;
  duration: number | null;
  waveformData?: string | null;
};
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
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const SPECTRUM_BARS = 12;
const SPECTRUM_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const FLAT_SPECTRUM = "▁".repeat(SPECTRUM_BARS);

const STYLES = `
:host {
  --dl-bg: #0d0d0d;
  --dl-fg: #d8d8d8;
  --dl-accent: #fc0;
  --dl-muted: #6b6b6b;
  --dl-border: #2e2e2e;
  --dl-wave-dim: #3f3f3f;
  --dl-font: "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --dl-font-size: 13px;
  --dl-radius: 0;
  --dl-padding: 12px;
  display: block;
  position: relative;
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
button { background: none; border: none; color: var(--dl-muted); font: inherit; cursor: pointer; padding: 4px 2px; white-space: pre; }
button:hover { color: var(--dl-accent); }
.toggle { color: var(--dl-accent); }
.toggle:hover { color: var(--dl-fg); }
.state { user-select: none; }
/* The title box. flex-basis 0 (not auto) is load-bearing twice over: it makes
   the width come from the flex distribution rather than the text, which is
   what lets container-type be used safely here, and it stops a long title
   from pushing the row wide. min-width keeps a readable amount of title even
   when everything else wants the space — before this, .now resolved to 0px at
   any container under ~420px and the title vanished completely. */
.now { flex: 1 1 0; min-width: 8ch; overflow: hidden; container-type: inline-size; }
/* Travel is the container width minus the text's own width — exactly what is
   hidden, and 0 for a title that already fits, so short names never move. */
.now-text { display: inline-block; white-space: nowrap; animation: dl-drift 12s ease-in-out infinite alternate; }
@keyframes dl-drift {
  from { transform: translateX(0); }
  to { transform: translateX(min(0px, calc(100cqw - 100%))); }
}
@media (prefers-reduced-motion: reduce) {
  .now-text { animation: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
}
/* Must be allowed to clip. It is 12 fixed monospace characters, so its
   min-content width is the whole thing; without min-width:0 it refuses to
   shrink and takes 106px out of the row no matter how narrow the host is.
   The LED waveform directly below carries the same signal, so losing bars
   here costs nothing. */
.spectrum { color: var(--dl-accent); white-space: pre; letter-spacing: 1px; line-height: 1; user-select: none; min-width: 0; overflow: hidden; }
.time { color: var(--dl-muted); font-size: 0.9em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wave { display: block; width: 100%; height: 40px; cursor: pointer; }
.wave-wrap { padding: 6px var(--dl-padding); border-bottom: 1px solid var(--dl-border); }
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

export class DemoLockerPlayer extends HTMLElement {
  private shadow: ShadowRoot;
  private audio = new Audio();
  private data: PlaylistData | null = null;
  private current = -1;
  private loadGeneration = 0;
  private analyser: AnalyserNode | null = null;
  private analyserFailed = false;
  private spectrumData: Uint8Array<ArrayBuffer> | null = null;
  private raf = 0;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.audio.preload = "none";
    // CORS-readable audio lets the Web Audio analyser drive the spectrum.
    // If the instance's stream isn't CORS-clean the media load fails, and the
    // error handler below retries cookie-style without CORS (no spectrum).
    this.audio.crossOrigin = "anonymous";
    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("timeupdate", () => this.updateTime());
    this.audio.addEventListener("play", () => {
      this.startSpectrum();
      this.render();
    });
    this.audio.addEventListener("pause", () => {
      this.stopSpectrum();
      this.render();
    });
    this.audio.addEventListener("error", () => {
      if (this.audio.crossOrigin && this.audio.src) {
        this.audio.crossOrigin = null;
        this.analyserFailed = true;
        const at = this.audio.currentTime;
        this.audio.src = this.audio.src;
        this.audio.currentTime = at;
        this.audio.play().catch(() => {});
      }
    });
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
    const gen = ++this.loadGeneration;
    try {
      const res = await fetch(`${this.instance}/public/v1/playlists/${encodeURIComponent(playlistId)}`);
      if (gen !== this.loadGeneration) return;
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      if (gen !== this.loadGeneration) return;
      this.data = json.playlist;
      this.render();
    } catch {
      if (gen !== this.loadGeneration) return;
      this.renderStatus("playlist unavailable");
    }
  }

  disconnectedCallback() {
    this.loadGeneration++;
    this.stopSpectrum();
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

  // --- spectrum -------------------------------------------------------------

  private ensureAnalyser(): AnalyserNode | null {
    if (this.analyser || this.analyserFailed) return this.analyser;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(this.audio);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.75;
      src.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      this.audio.addEventListener("play", () => ctx.resume());
      if (ctx.state === "suspended") ctx.resume();
    } catch {
      this.analyserFailed = true;
      this.analyser = null;
    }
    return this.analyser;
  }

  private spectrumFrame(): string {
    const a = this.ensureAnalyser();
    if (!a) return FLAT_SPECTRUM;
    if (!this.spectrumData || this.spectrumData.length !== a.frequencyBinCount) {
      this.spectrumData = new Uint8Array(a.frequencyBinCount);
    }
    a.getByteFrequencyData(this.spectrumData);
    const data = this.spectrumData;
    const usable = Math.max(SPECTRUM_BARS, Math.floor(data.length * 0.66));
    const perBar = usable / SPECTRUM_BARS;
    let out = "";
    for (let i = 0; i < SPECTRUM_BARS; i++) {
      let sum = 0;
      const start = Math.floor(i * perBar);
      const end = Math.max(start + 1, Math.floor((i + 1) * perBar));
      for (let j = start; j < end; j++) sum += data[j];
      const avg = sum / (end - start) / 255;
      out += SPECTRUM_BLOCKS[Math.min(SPECTRUM_BLOCKS.length - 1, Math.round(avg * (SPECTRUM_BLOCKS.length - 1)))];
    }
    return out;
  }

  private startSpectrum() {
    this.stopSpectrum();
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 66) {
        last = t;
        const el = this.shadow.querySelector(".spectrum");
        if (el) el.textContent = this.spectrumFrame();
        this.drawWave();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopSpectrum() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const el = this.shadow.querySelector(".spectrum");
    if (el) el.textContent = FLAT_SPECTRUM;
  }

  // --- waveform -------------------------------------------------------------

  private trackDuration(): number | null {
    return Number.isFinite(this.audio.duration) && this.audio.duration > 0
      ? this.audio.duration
      : (this.data?.tracks[this.current]?.duration ?? null);
  }

  private drawWave() {
    const canvas = this.shadow.querySelector<HTMLCanvasElement>(".wave");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const styles = getComputedStyle(this);
    const accent = styles.getPropertyValue("--dl-accent").trim() || "#fc0";
    const dim = styles.getPropertyValue("--dl-wave-dim").trim() || "#3f3f3f";

    let peaks: number[] = [];
    const raw = this.current >= 0 ? this.data?.tracks[this.current]?.waveformData : null;
    if (raw) {
      try {
        peaks = JSON.parse(raw);
      } catch {
        peaks = [];
      }
    }

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (!cssWidth) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const duration = this.trackDuration();
    const progress = duration ? this.audio.currentTime / duration : 0;

    if (peaks.length === 0) {
      // no waveform data — segmented TUI progress line (╍ ╍ ╍)
      const segW = 8;
      const gap = 3;
      for (let x = 0; x < cssWidth; x += segW + gap) {
        ctx.fillStyle = x / cssWidth < progress ? accent : dim;
        ctx.fillRect(x, cssHeight / 2 - 1, Math.min(segW, cssWidth - x), 3);
      }
      return;
    }

    // segmented "LED cell" bars, matching the demo-locker app player
    const maxPeak = Math.max(...peaks.map(Math.abs)) || 1;
    const cellH = 4; // 3px lit + 1px gap
    const colW = Math.max(cssWidth / peaks.length, 2);
    for (let i = 0; i < peaks.length; i++) {
      const x = i * colW;
      const normalized = Math.abs(peaks[i]) / maxPeak;
      const barHeight = normalized * (cssHeight * 0.9);
      const cells = Math.max(1, Math.round(barHeight / cellH));
      ctx.fillStyle = i / peaks.length < progress ? accent : dim;
      const top = cssHeight / 2 - (cells * cellH) / 2;
      for (let cIdx = 0; cIdx < cells; cIdx++) {
        ctx.fillRect(x, top + cIdx * cellH, Math.max(colW - 1, 1), cellH - 1);
      }
    }
  }

  // --- rendering ------------------------------------------------------------

  private updateTime() {
    const time = this.shadow.querySelector(".time");
    if (time) {
      time.textContent = `${formatTime(this.audio.currentTime)} / ${formatTime(this.trackDuration())}`;
    }
    this.drawWave();
  }

  private renderStatus(msg: string) {
    this.shadow.innerHTML = `<style>${STYLES}</style><div class="status" part="status"></div>`;
    this.shadow.querySelector(".status")!.textContent = msg;
  }

  private render() {
    if (!this.data) return;
    const playing = this.current >= 0 && !this.audio.paused;
    const nowTitle = this.current >= 0 ? this.data.tracks[this.current]?.title : null;

    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="header" part="header">
        <div class="artwork-slot"></div>
        <div class="title" part="title"></div>
      </div>
      <div class="transport" part="transport">
        <button class="prev" part="button">[⏮]</button>
        <button class="toggle" part="button">${playing ? "[❚❚]" : "[▶]"}</button>
        <button class="nextb" part="button">[⏭]</button>
        <span class="state" part="state" style="color: var(${playing ? "--dl-accent" : "--dl-muted"})">${playing ? "●" : "■"}</span>
        <span class="now" part="now"><span class="now-text" part="now-text"></span></span>
        <span class="spectrum" part="spectrum">${FLAT_SPECTRUM}</span>
        <span class="time" part="time">--:-- / --:--</span>
      </div>
      <div class="wave-wrap" part="seek">
        <canvas class="wave" title="Click to seek"></canvas>
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
    this.shadow.querySelector(".now-text")!.textContent = nowTitle ? `♫ ${nowTitle}` : "";

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
    this.shadow.querySelector<HTMLCanvasElement>(".wave")!.addEventListener("click", (e) => {
      const duration = this.trackDuration();
      if (!duration) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.audio.currentTime = pct * duration;
      this.drawWave();
    });

    if (playing) this.startSpectrum();
    this.updateTime();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "demo-locker-player": DemoLockerPlayer;
  }
}

if (!customElements.get("demo-locker-player")) {
  customElements.define("demo-locker-player", DemoLockerPlayer);
}
