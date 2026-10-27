// Clip storage: data/clips/<id>/ holds source.<ext>, sampled.mp4, meta.json, entities.json,
// tracks/, and later adjudications.json and analysis.json.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLE_FPS } from "../engine/config.ts";
import { DEFAULT_ENTITIES, writeEntities } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { probe, resample, type ProbeInfo } from "./ffmpeg.ts";
import { CLIPS_DIR, clipDir, entitiesPath, isValidClipId, metaPath, sampledPath } from "./paths.ts";

export interface ClipMeta {
  readonly id: string;
  readonly createdAt: string;
  readonly originalName: string;
  readonly sourceFile: string;
  readonly source: ProbeInfo;
  readonly sampled: ProbeInfo;
  readonly fps: number;
  // Files API id of the uploaded sampled clip, kept so every class call reuses one upload.
  readonly remoteFileId?: string;
}

const SOURCE_EXTENSIONS = [".mp4", ".mov", ".m4v"];

export async function readMeta(clipId: string): Promise<ClipMeta> {
  if (!isValidClipId(clipId)) throw new HttpError(400, "invalid clip id");
  try {
    return JSON.parse(await readFile(metaPath(clipId), "utf8")) as ClipMeta;
  } catch {
    throw new HttpError(404, `clip ${clipId} not found`);
  }
}

export async function writeMeta(meta: ClipMeta): Promise<void> {
  await writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

async function findSource(clipId: string): Promise<string | null> {
  const dir = clipDir(clipId);
  if (!existsSync(dir)) return null;
  for (const name of await readdir(dir)) {
    if (name.startsWith("source") && SOURCE_EXTENSIONS.includes(path.extname(name).toLowerCase())) return name;
  }
  return null;
}

// Returns the clip meta, creating it when a folder with a source file exists but has not been
// probed and resampled yet (a clip dropped in by hand, like the dev clip).
export async function ensureClip(clipId: string): Promise<ClipMeta> {
  if (!isValidClipId(clipId)) throw new HttpError(400, "invalid clip id");
  if (existsSync(metaPath(clipId))) return readMeta(clipId);
  const sourceFile = await findSource(clipId);
  if (!sourceFile) throw new HttpError(404, `clip ${clipId} has no source video`);
  const sourcePath = path.join(clipDir(clipId), sourceFile);
  const source = await probe(sourcePath);
  await resample(sourcePath, sampledPath(clipId), SAMPLE_FPS);
  const sampled = await probe(sampledPath(clipId), { countFrames: true });
  const meta: ClipMeta = {
    id: clipId,
    createdAt: new Date().toISOString(),
    originalName: sourceFile,
    sourceFile,
    source,
    sampled,
    fps: SAMPLE_FPS,
  };
  await writeMeta(meta);
  if (!existsSync(entitiesPath(clipId))) await writeEntities(clipId, DEFAULT_ENTITIES);
  return meta;
}

export function newClipId(): string {
  return `c_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

// Moves an uploaded temp file into a new clip folder and runs ensureClip on it. The duration
// cap is checked with a probe before any resampling, and a rejected clip leaves nothing behind.
export async function createClipFromUpload(tmpPath: string, originalName: string, maxSeconds: number): Promise<ClipMeta> {
  const ext = path.extname(originalName).toLowerCase();
  if (!SOURCE_EXTENSIONS.includes(ext)) {
    await rm(tmpPath, { force: true });
    throw new HttpError(400, `unsupported video type ${ext || "(none)"}; use mp4 or mov`);
  }
  let info: ProbeInfo;
  try {
    info = await probe(tmpPath);
  } catch {
    await rm(tmpPath, { force: true });
    throw new HttpError(400, "the file is not a readable video");
  }
  if (info.durationS > maxSeconds) {
    await rm(tmpPath, { force: true });
    throw new HttpError(413, `clip is ${info.durationS.toFixed(1)} s; the limit is ${maxSeconds} s`);
  }
  const id = newClipId();
  await mkdir(clipDir(id), { recursive: true });
  await rename(tmpPath, path.join(clipDir(id), `source${ext}`));
  try {
    return await ensureClip(id);
  } catch (err) {
    await rm(clipDir(id), { recursive: true, force: true });
    throw err;
  }
}

export async function listClipIds(): Promise<string[]> {
  if (!existsSync(CLIPS_DIR)) return [];
  const names = await readdir(CLIPS_DIR, { withFileTypes: true });
  return names.filter((d) => d.isDirectory() && isValidClipId(d.name)).map((d) => d.name).sort();
}
