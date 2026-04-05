import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

function tmpPath(ext: string): string {
  return join(tmpdir(), `dl-${randomBytes(8).toString("hex")}${ext}`);
}

export interface TranscodeResult {
  buffer: Buffer;
  duration: number;
}

export async function transcodeToAAC(
  inputBuffer: Buffer
): Promise<TranscodeResult> {
  const inputPath = tmpPath(".input");
  const outputPath = tmpPath(".m4a");

  try {
    await writeFile(inputPath, inputBuffer);

    await execFileAsync("ffmpeg", [
      "-i", inputPath,
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);

    // get duration
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      inputPath,
    ]);
    const duration = parseFloat(stdout.trim()) || 0;

    const buffer = await readFile(outputPath);
    return { buffer, duration };
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

export async function generateWaveform(
  inputBuffer: Buffer
): Promise<number[]> {
  const inputPath = tmpPath(".input");
  const outputPath = tmpPath(".json");

  try {
    await writeFile(inputPath, inputBuffer);

    // audiowaveform generates peaks data
    // fallback: if audiowaveform isn't installed, generate basic peaks with ffmpeg
    try {
      await execFileAsync("audiowaveform", [
        "-i", inputPath,
        "-o", outputPath,
        "--pixels-per-second", "10",
        "-b", "8",
        "--output-format", "json",
      ]);
      const json = JSON.parse(await readFile(outputPath, "utf-8"));
      return json.data as number[];
    } catch {
      // fallback: return empty array, waveform can be generated later
      console.warn("audiowaveform not found, skipping waveform generation");
      return [];
    }
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}
