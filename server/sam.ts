// SAM 3.1 segmentation through the Meta Model API, behind a SegmentationBackend interface so
// fal.ai could be swapped in without touching callers. Results are cached per clip per phrase
// under data/clips/<id>/tracks/<slug>.json. A cached phrase is never called again.
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import { buildObjectPrompt, decodeMaskToRaster, frameIndexOf, parseImageStream, parseVideoStream, recordsOfKind } from "@meta-sam/parser";
import type { FrameSize, MaskBounds, MaskRecord } from "../engine/types.ts";
import { readMeta, writeMeta, type ClipMeta } from "./clips.ts";
import { requireEnv } from "./env.ts";
import { HttpError } from "./errors.ts";
import { sampledPath, trackPath, tracksDir } from "./paths.ts";

export const META_BASE_URL = "https://api.meta.ai/v1";
const SAM_MODEL = "sam-3.1";
// Published price, $0.20 per 1,000 video frames, 50 frame minimum per request.
const SAM_PRICE_PER_FRAME = 0.2 / 1000;
const SAM_MIN_BILLED_FRAMES = 50;

export interface SegmentationUsage {
  readonly videoFramesProcessed?: number;
}

export interface SegmentationResult {
  readonly backend: string;
  readonly phrase: string;
  readonly outcome: string;
  readonly records: readonly MaskRecord[];
  readonly usage: SegmentationUsage;
  readonly elapsedMs: number;
  readonly warnings: readonly string[];
}

export interface SegmentationBackend {
  readonly name: string;
  segmentVideo(clip: ClipMeta, phrase: string): Promise<SegmentationResult>;
}

export interface TrackFile extends SegmentationResult {
  readonly clipId: string;
  readonly frameSize: FrameSize;
  readonly fps: number;
  readonly createdAt: string;
}

export function estimateSamCost(frames: number | undefined): number | undefined {
  if (frames === undefined) return undefined;
  return Math.max(frames, SAM_MIN_BILLED_FRAMES) * SAM_PRICE_PER_FRAME;
}

let client: OpenAI | null = null;
function metaClient(): OpenAI {
  if (!client) client = new OpenAI({ baseURL: META_BASE_URL, apiKey: requireEnv("MODEL_API_KEY") });
  return client;
}

// Upload the sampled clip once and remember the Files API id in meta.json.
export async function ensureRemoteFile(clip: ClipMeta): Promise<string> {
  if (clip.remoteFileId) return clip.remoteFileId;
  const uploaded = await metaClient().files.create({
    file: await toFile(createReadStream(sampledPath(clip.id)), "sampled.mp4", { type: "video/mp4" }),
    purpose: "user_data",
  });
  // Re-read meta.json first: a title or story saved while the upload ran must not be clobbered.
  const fresh = await readMeta(clip.id);
  await writeMeta({ ...fresh, remoteFileId: uploaded.id });
  console.log(`files   | ${clip.id} | uploaded sampled.mp4 as ${uploaded.id}`);
  return uploaded.id;
}

async function forgetRemoteFile(clip: ClipMeta): Promise<ClipMeta> {
  const { remoteFileId: _dropped, ...rest } = await readMeta(clip.id);
  await writeMeta(rest);
  return rest;
}

function isMissingFileError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 404 || /file[^.]{0,40}(not found|does not exist|expired|invalid)/i.test(e?.message ?? "");
}

// Removes the clip from the Meta Files API once every class is cached. A later new phrase
// simply uploads again. Keeps footage on the API side only as long as segmentation needs it.
// A 404 from the delete means it is already gone; the id is dropped either way.
export async function deleteRemoteFile(clip: ClipMeta): Promise<void> {
  if (!clip.remoteFileId) return;
  try {
    await metaClient().files.delete(clip.remoteFileId);
  } catch (err) {
    if (!isMissingFileError(err)) throw err;
  }
  await forgetRemoteFile(clip);
  console.log(`files   | ${clip.id} | deleted remote ${clip.remoteFileId} after segmentation`);
}

// Pass events through to the parser while capturing usage from the terminal event.
async function* tee(stream: AsyncIterable<unknown>, sink: { usage?: SegmentationUsage }): AsyncIterable<{ type: string }> {
  for await (const raw of stream) {
    const event = raw as { type: string; response?: { usage?: { video_frames_processed?: number } } };
    if (event.type === "response.completed") {
      const frames = event.response?.usage?.video_frames_processed;
      sink.usage = frames === undefined ? {} : { videoFramesProcessed: frames };
    }
    yield event;
  }
}

export interface BoxPrompt {
  readonly frameIndex: number;
  readonly box: MaskBounds;
  readonly direction?: "both" | "forward" | "backward";
}

// Phrase keys for box-tracked entities, so the same cache and loaders work: "box:<entityId>".
export const BOX_PREFIX = "box:";
export function isBoxPhrase(phrase: string): boolean {
  return phrase.startsWith(BOX_PREFIX);
}

export class MetaSamBackend implements SegmentationBackend {
  readonly name = "meta-model-api";

  async segmentVideo(clip: ClipMeta, phrase: string): Promise<SegmentationResult> {
    return this.withRemoteFile(clip, (c, fileId) => this.segmentWithFile(c, phrase, fileId));
  }

  // Track one object from a box drawn on a frame, forward and backward through the clip.
  async segmentVideoByBox(clip: ClipMeta, key: string, prompt: BoxPrompt): Promise<SegmentationResult> {
    const text = buildObjectPrompt({
      size: { width: clip.sampled.width, height: clip.sampled.height },
      objects: [{ id: 1, prompts: [{ frame: prompt.frameIndex, box: prompt.box }] }],
    });
    return this.withRemoteFile(clip, (c, fileId) => this.segmentWithFile(c, key, fileId, text, prompt.direction ?? "both"));
  }

  private async withRemoteFile(clip: ClipMeta, run: (clip: ClipMeta, fileId: string) => Promise<SegmentationResult>): Promise<SegmentationResult> {
    try {
      return await run(clip, await ensureRemoteFile(clip));
    } catch (err) {
      // A remembered file id can go stale (expired, or deleted out of band). Upload once more.
      if (!clip.remoteFileId || !isMissingFileError(err)) throw err;
      console.log(`files   | ${clip.id} | remote ${clip.remoteFileId} is gone, uploading again`);
      const fresh = await forgetRemoteFile(clip);
      return run(fresh, await ensureRemoteFile(fresh));
    }
  }

  private async segmentWithFile(clip: ClipMeta, phrase: string, fileId: string, promptText: string = phrase, direction?: "both" | "forward" | "backward"): Promise<SegmentationResult> {
    const started = Date.now();
    const sink: { usage?: SegmentationUsage } = {};
    const stream = await metaClient().responses.create({
      model: SAM_MODEL,
      stream: true,
      metadata: { mask_encoding: "one_bit", include_confidence: "true", ...(direction ? { propagation_direction: direction } : {}) },
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: promptText },
            { type: "input_video", file_id: fileId },
          ],
        },
      ],
    } as never);
    const result = await parseVideoStream(tee(stream as unknown as AsyncIterable<unknown>, sink)).finalResult;
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (result.outcome.status !== "completed") {
      throw new Error(`SAM ${phrase}: response ${result.outcome.status} (${result.outcome.reason})`);
    }
    if (errors.length > 0) {
      throw new Error(`SAM ${phrase}: parser rejected ${errors.length} lines, first: ${errors[0]?.message}`);
    }
    const records: MaskRecord[] = recordsOfKind(result.records, "mask").map((m) => {
      const frameIndex = frameIndexOf(m);
      if (frameIndex === undefined) throw new Error(`SAM ${phrase}: mask record without a frame`);
      // Validate the payload once here so a bad record fails at cache time, not at analysis time.
      decodeMaskToRaster(m.mask);
      const rec: MaskRecord = {
        frameIndex,
        objectId: m.objectId,
        bounds: { left: m.bounds.left, top: m.bounds.top, right: m.bounds.right, bottom: m.bounds.bottom },
        mask: { encoding: m.mask.encoding, width: m.mask.width, height: m.mask.height, payload: m.mask.payload },
        ...(m.confidence === undefined ? {} : { confidence: m.confidence }),
      };
      return rec;
    });
    return {
      backend: this.name,
      phrase,
      outcome: result.outcome.status,
      records,
      usage: sink.usage ?? {},
      elapsedMs: Date.now() - started,
      warnings: result.diagnostics.filter((d) => d.severity === "warning").map((d) => `${d.code}: ${d.message}`),
    };
  }
}

// One still frame, one phrase: for testing a candidate phrase before spending a clip run on it.
export async function segmentImage(png: Buffer, phrase: string): Promise<{ records: MaskRecord[]; elapsedMs: number }> {
  const started = Date.now();
  const stream = await metaClient().responses.create({
    model: SAM_MODEL,
    stream: true,
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: phrase },
          { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
        ],
      },
    ],
  } as never);
  const result = await parseImageStream(stream as unknown as AsyncIterable<{ type: string }>).finalResult;
  if (result.outcome.status !== "completed") throw new Error(`SAM image "${phrase}": response ${result.outcome.status} (${result.outcome.reason})`);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(`SAM image "${phrase}": parser rejected ${errors.length} lines, first: ${errors[0]?.message}`);
  const records: MaskRecord[] = recordsOfKind(result.records, "mask").map((m) => ({
    frameIndex: 0,
    objectId: m.objectId,
    bounds: { left: m.bounds.left, top: m.bounds.top, right: m.bounds.right, bottom: m.bounds.bottom },
    mask: { encoding: m.mask.encoding, width: m.mask.width, height: m.mask.height, payload: m.mask.payload },
    ...(m.confidence === undefined ? {} : { confidence: m.confidence }),
  }));
  return { records, elapsedMs: Date.now() - started };
}

export async function readTrack(clipId: string, phrase: string): Promise<TrackFile | null> {
  const file = trackPath(clipId, phrase);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as TrackFile;
}

async function cacheTrack(clipId: string, clip: ClipMeta, phrase: string, result: SegmentationResult): Promise<TrackFile> {
  const frames = new Set(result.records.map((r) => r.frameIndex)).size;
  const objects = new Set(result.records.map((r) => r.objectId)).size;
  const cost = estimateSamCost(result.usage.videoFramesProcessed);
  console.log(
    `sam     | ${clipId} | ${phrase.padEnd(24)} | frames=${String(frames).padStart(4)} objects=${objects} | ${String(result.elapsedMs).padStart(6)} ms | billed=${result.usage.videoFramesProcessed ?? "?"} | ${cost === undefined ? "cost=?" : `$${cost.toFixed(3)}`}`,
  );
  const track: TrackFile = {
    ...result,
    clipId,
    frameSize: { w: clip.sampled.width, h: clip.sampled.height },
    fps: clip.fps,
    createdAt: new Date().toISOString(),
  };
  await mkdir(tracksDir(clipId), { recursive: true });
  await writeFile(trackPath(clipId, phrase), JSON.stringify(track));
  return track;
}

// Returns the cached track for a phrase, calling the backend only when no cache exists.
export async function segmentPhrase(clipId: string, phrase: string, backend: SegmentationBackend): Promise<TrackFile> {
  const cached = await readTrack(clipId, phrase);
  if (cached) return cached;
  if (isBoxPhrase(phrase)) throw new HttpError(409, `${phrase.slice(BOX_PREFIX.length)} is tracked from a drawn box and its track is missing; draw the box again`);
  const clip = await readMeta(clipId);
  return cacheTrack(clipId, clip, phrase, await backend.segmentVideo(clip, phrase));
}

// Tracks an object from a box on one frame and caches it under the entity's box key. Nothing is
// cached when SAM returns no frames, so a failed box leaves no trace.
export async function segmentBox(clipId: string, entityId: string, prompt: BoxPrompt, backend: MetaSamBackend): Promise<TrackFile | null> {
  const clip = await readMeta(clipId);
  const key = `${BOX_PREFIX}${entityId}`;
  const result = await backend.segmentVideoByBox(clip, key, prompt);
  if (result.records.length === 0) {
    console.log(`sam     | ${clipId} | ${key} | box tracked nothing, not cached`);
    return null;
  }
  return cacheTrack(clipId, clip, key, result);
}
