// Extract a downsampled peak array + duration from an audio file using Web Audio.
// Runs in the browser before upload so the Worker doesn't need ffmpeg.

const TARGET_PEAKS = 400;

export type PeaksResult = {
  peaks: number[];
  duration: number;
};

export async function extractPeaks(file: File): Promise<PeaksResult> {
  const arrayBuffer = await file.arrayBuffer();

  // Some browsers still gate AudioContext behind the webkit prefix
  const Ctx: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  const ctx = new Ctx();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    // close eagerly so we don't pile up contexts during multi-file uploads
    if (ctx.state !== "closed") {
      ctx.close().catch(() => {});
    }
  }

  const channelData = audioBuffer.getChannelData(0);
  const samplesPerPeak = Math.max(1, Math.floor(channelData.length / TARGET_PEAKS));
  const peaks: number[] = [];

  for (let i = 0; i < TARGET_PEAKS; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, channelData.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(channelData[j]);
      if (v > max) max = v;
    }
    peaks.push(Math.round(max * 1000) / 1000);
  }

  return {
    peaks,
    duration: audioBuffer.duration,
  };
}
