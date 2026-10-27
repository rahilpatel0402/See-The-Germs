// Where clip data lives on disk. Everything under data/ is gitignored and cacheable.
import path from "node:path";

export const ROOT = process.cwd();
export const CLIPS_DIR = path.join(ROOT, "data", "clips");
export const TMP_DIR = path.join(ROOT, "data", "tmp");

export function clipDir(clipId: string): string {
  return path.join(CLIPS_DIR, clipId);
}

export function tracksDir(clipId: string): string {
  return path.join(clipDir(clipId), "tracks");
}

export function metaPath(clipId: string): string {
  return path.join(clipDir(clipId), "meta.json");
}

export function entitiesPath(clipId: string): string {
  return path.join(clipDir(clipId), "entities.json");
}

export function analysisPath(clipId: string): string {
  return path.join(clipDir(clipId), "analysis.json");
}

export function adjudicationsPath(clipId: string): string {
  return path.join(clipDir(clipId), "adjudications.json");
}

export function sampledPath(clipId: string): string {
  return path.join(clipDir(clipId), "sampled.mp4");
}

// File-safe slug for a SAM phrase: "white rod" -> "white_rod".
export function slug(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function trackPath(clipId: string, phrase: string): string {
  return path.join(tracksDir(clipId), `${slug(phrase)}.json`);
}

export function isValidClipId(clipId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(clipId);
}
