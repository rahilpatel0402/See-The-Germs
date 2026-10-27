// Renders one sampled frame with mask outlines drawn on it, for vision adjudication and for
// the UI later. Raw frames are cached under data/clips/<id>/frames/.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { decodeMaskToSVGPath } from "@meta-sam/parser";
import type { MaskRecord } from "../engine/types.ts";
import { readMeta } from "./clips.ts";
import { extractFrame } from "./ffmpeg.ts";
import { clipDir, sampledPath } from "./paths.ts";

export interface Outline {
  readonly records: readonly MaskRecord[];
  readonly color: string;
  readonly strokeWidth?: number;
}

export function framesDir(clipId: string): string {
  return path.join(clipDir(clipId), "frames");
}

export async function rawFramePath(clipId: string, frameIndex: number): Promise<string> {
  const meta = await readMeta(clipId);
  await mkdir(framesDir(clipId), { recursive: true });
  const file = path.join(framesDir(clipId), `f${String(frameIndex).padStart(5, "0")}.png`);
  if (!existsSync(file)) await extractFrame(sampledPath(clipId), frameIndex / meta.fps, file);
  return file;
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

export function outlineSvg(width: number, height: number, outlines: readonly Outline[]): string {
  const paths: string[] = [];
  for (const outline of outlines) {
    for (const record of outline.records) {
      const d = decodeMaskToSVGPath(record.mask);
      if (d === "") continue;
      paths.push(
        `<path d="${d}" transform="translate(${record.bounds.left} ${record.bounds.top})" fill="none" stroke="${escapeAttr(outline.color)}" stroke-width="${outline.strokeWidth ?? 3}" stroke-linejoin="round"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join("")}</svg>`;
}

export async function renderAnnotatedFrame(clipId: string, frameIndex: number, outlines: readonly Outline[]): Promise<Buffer> {
  const meta = await readMeta(clipId);
  const raw = await rawFramePath(clipId, frameIndex);
  const svg = outlineSvg(meta.sampled.width, meta.sampled.height, outlines);
  return sharp(raw).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}
