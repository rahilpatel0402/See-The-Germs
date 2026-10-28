// ffprobe and ffmpeg through child_process. FFMPEG_DIR in .env points at a bin folder when the
// tools are not on PATH.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function bin(name: string): string {
  const dir = process.env["FFMPEG_DIR"];
  return dir ? path.join(dir, name) : name;
}

export interface ProbeInfo {
  // Display size after any rotation metadata is applied.
  readonly width: number;
  readonly height: number;
  readonly codec: string;
  readonly fps: number;
  readonly frames: number;
  readonly durationS: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return n ?? 0;
  return n / d;
}

// countFrames decodes the whole file to count frames exactly; only the resampled clip needs
// that (the engine relies on its frame count). The source probe uses the container's metadata.
export async function probe(file: string, options: { countFrames?: boolean } = {}): Promise<ProbeInfo> {
  const { stdout } = await run(bin("ffprobe"), [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...(options.countFrames ? ["-count_frames"] : []), file,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string } };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) throw new Error(`ffprobe: no video stream in ${file}`);
  const rotation = Math.abs(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(video.tags?.rotate ?? 0));
  const swap = rotation % 180 === 90;
  const fps = parseRate(video.r_frame_rate);
  const frames = Number(video.nb_read_frames ?? video.nb_frames ?? 0);
  let durationS = Number(parsed.format?.duration ?? (video as { duration?: string }).duration ?? 0);
  // A browser-recorded webm often has no duration in its header. Count frames once and derive it.
  if (!(durationS > 0) && !options.countFrames) return probe(file, { countFrames: true });
  if (!(durationS > 0) && frames > 0 && fps > 0) durationS = frames / fps;
  return {
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    codec: video.codec_name ?? "unknown",
    fps,
    frames,
    durationS,
  };
}

// Constant frame rate, longer side capped so the shorter side is 720, H.264, faststart, no audio.
// Frame N of the output is at exactly N / fps seconds, which the engine relies on.
export async function resample(src: string, dst: string, fps: number): Promise<void> {
  const scale = "scale=w='if(gte(iw,ih),-2,720)':h='if(gte(iw,ih),720,-2)'";
  await run(bin("ffmpeg"), [
    "-y", "-v", "error", "-i", src,
    "-vf", `fps=${fps},${scale}`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", dst,
  ]);
}

// One frame at time t as a PNG. Used later for adjudication images.
export async function extractFrame(src: string, t: number, dst: string): Promise<void> {
  await run(bin("ffmpeg"), ["-y", "-v", "error", "-ss", String(t), "-i", src, "-frames:v", "1", dst]);
}
