// TUI spectrum visualizer backend. Routes the shared <audio> element through
// a Web Audio AnalyserNode (created lazily, on first use after a user gesture
// so the AudioContext is allowed to start) and renders frequency bins as
// terminal block characters.
import { getAudioElement } from "./audio";

let analyser: AnalyserNode | null = null;
let failed = false;
let data: Uint8Array<ArrayBuffer> | null = null;

function getAnalyser(): AnalyserNode | null {
  if (analyser || failed) return analyser;
  try {
    const audio = getAudioElement();
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    // Autoplay policy can leave the context suspended; resume on playback.
    audio.addEventListener("play", () => ctx.resume());
    if (ctx.state === "suspended") ctx.resume();
  } catch {
    failed = true; // e.g. CORS-tainted source — visualizer just stays flat
    analyser = null;
  }
  return analyser;
}

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// One frame of the spectrum as a string of `bars` block characters.
export function spectrumFrame(bars: number): string {
  const a = getAnalyser();
  if (!a) return "▁".repeat(bars);
  if (!data || data.length !== a.frequencyBinCount) {
    data = new Uint8Array(a.frequencyBinCount);
  }
  a.getByteFrequencyData(data);

  // Use the lower ~2/3 of the bins (music energy lives there), grouped evenly.
  const usable = Math.max(bars, Math.floor(data.length * 0.66));
  const perBar = usable / bars;
  let out = "";
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    const start = Math.floor(i * perBar);
    const end = Math.max(start + 1, Math.floor((i + 1) * perBar));
    for (let j = start; j < end; j++) sum += data[j];
    const avg = sum / (end - start) / 255;
    const level = Math.min(BLOCKS.length - 1, Math.round(avg * (BLOCKS.length - 1)));
    out += BLOCKS[level];
  }
  return out;
}
