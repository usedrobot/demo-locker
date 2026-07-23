import { tracks as tracksApi, type Track } from "./api";

type PlayerState = {
  track: Track | null;
  playing: boolean;
  currentTime: number;
  duration: number;
};

type Listener = (state: PlayerState) => void;

const audio = new Audio();
// Allow Web Audio (spectrum analyser) to read samples from the cross-origin
// stream — the API serves audio with permissive CORS on all deploy targets.
audio.crossOrigin = "anonymous";

// For the spectrum visualizer — see lib/visualizer.ts
export function getAudioElement(): HTMLAudioElement {
  return audio;
}
let playlist: Track[] = [];
let currentIndex = -1;
let listeners: Listener[] = [];

function getState(): PlayerState {
  return {
    track: currentIndex >= 0 ? playlist[currentIndex] : null,
    playing: !audio.paused,
    currentTime: audio.currentTime,
    duration: audio.duration || 0,
  };
}

function notify() {
  const state = getState();
  listeners.forEach((fn) => fn(state));
}

audio.addEventListener("timeupdate", notify);
audio.addEventListener("play", notify);
audio.addEventListener("pause", notify);
audio.addEventListener("ended", () => {
  // auto-advance
  if (currentIndex < playlist.length - 1) {
    playIndex(currentIndex + 1);
  } else {
    notify();
  }
});

function playIndex(index: number) {
  if (index < 0 || index >= playlist.length) return;
  currentIndex = index;
  const track = playlist[index];
  if (!track.streamKey) return;

  audio.src = tracksApi.streamUrl(track.id);
  audio.play();
}

// Media Session API for lock screen controls
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => {
    if (currentIndex > 0) playIndex(currentIndex - 1);
  });
  navigator.mediaSession.setActionHandler("nexttrack", () => {
    if (currentIndex < playlist.length - 1) playIndex(currentIndex + 1);
  });
}

export const player = {
  setPlaylist(tracks: Track[]) {
    playlist = tracks;
  },

  play(trackId?: string) {
    if (trackId) {
      const idx = playlist.findIndex((t) => t.id === trackId);
      if (idx >= 0) playIndex(idx);
    } else {
      audio.play();
    }
  },

  pause() {
    audio.pause();
  },

  toggle() {
    if (audio.paused) audio.play();
    else audio.pause();
  },

  next() {
    if (currentIndex < playlist.length - 1) playIndex(currentIndex + 1);
  },

  prev() {
    if (currentIndex > 0) playIndex(currentIndex - 1);
  },

  seek(time: number) {
    audio.currentTime = time;
  },

  // Stop playback and unload the current track (e.g. when it's deleted).
  clear() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentIndex = -1;
    notify();
  },

  getState,

  subscribe(fn: Listener) {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  },
};
