import { tracks as tracksApi, type Track } from "./api";

type PlayerState = {
  track: Track | null;
  // Which playlist the queue came from, or null for the library. A track can
  // be in several playlists, so the track alone cannot say (Player.tsx reads
  // this for artwork).
  playlistId: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  // 0..1, persisted in localStorage so it survives a reload.
  volume: number;
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
let playlistId: string | null = null;
let currentIndex = -1;
let listeners: Listener[] = [];

const VOLUME_KEY = "playerVolume";

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

function storedVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    return raw == null ? 1 : clampVolume(Number(raw));
  } catch {
    return 1;
  }
}

audio.volume = storedVolume();

// Play reporting. The track whose play has been loaded but not yet reported;
// cleared by the first `playing` event so a pause/resume of the same load
// never counts twice. Set fresh on every playIndex, so the next track in the
// queue (or the same track started over) reports again.
let unreportedTrackId: string | null = null;

function getState(): PlayerState {
  return {
    track: currentIndex >= 0 ? playlist[currentIndex] : null,
    playlistId,
    playing: !audio.paused,
    currentTime: audio.currentTime,
    duration: audio.duration || 0,
    volume: audio.volume,
  };
}

function notify() {
  const state = getState();
  listeners.forEach((fn) => fn(state));
}

audio.addEventListener("timeupdate", notify);
audio.addEventListener("play", notify);
audio.addEventListener("pause", notify);
audio.addEventListener("volumechange", notify);
audio.addEventListener("playing", () => {
  if (!unreportedTrackId) return;
  const id = unreportedTrackId;
  unreportedTrackId = null;
  // Fire and forget: a lost count is not worth interrupting playback for.
  tracksApi.recordPlay(id, playlistId).catch(() => {});
});
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
  if (!track.hasStream) return;

  audio.src = tracksApi.streamUrl(track.id);
  unreportedTrackId = track.id;
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
  setPlaylist(tracks: Track[], id: string | null = null) {
    playlist = tracks;
    playlistId = id;
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

  setVolume(v: number) {
    const vol = clampVolume(v);
    audio.volume = vol;
    try {
      localStorage.setItem(VOLUME_KEY, String(vol));
    } catch {
      // private mode / blocked storage: the level still applies for this page
    }
    // happy-dom and some browsers do not fire volumechange synchronously;
    // subscribers want the new level now.
    notify();
  },

  // Stop playback and unload the current track (e.g. when it's deleted).
  clear() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentIndex = -1;
    unreportedTrackId = null;
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
