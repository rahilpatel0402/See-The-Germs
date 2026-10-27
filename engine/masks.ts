// Full-frame binary mask primitives. Pure functions over FrameMask; no I/O, no model calls.
// Decoding the SAM base85 payload is delegated to @meta-sam/parser; everything else is ours.

import { decodeMaskToRaster } from "@meta-sam/parser";
import type { FrameMask, FrameSize, MaskBounds, MaskRecord } from "./types.ts";

export function emptyMask(size: FrameSize): FrameMask {
  return { w: size.w, h: size.h, data: new Uint8Array(size.w * size.h) };
}

// Build a mask from rows of "#" (set) and any other character (clear). For tests and fixtures.
export function fromPattern(rows: readonly string[]): FrameMask {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y] ?? "";
    if (row.length !== w) throw new Error(`fromPattern: row ${y} has length ${row.length}, expected ${w}`);
    for (let x = 0; x < w; x++) if (row[x] === "#") data[y * w + x] = 1;
  }
  return { w, h, data };
}

// Place a raster of rasterW x rasterH at bounds.left/top on a frame of the given size. Pixels
// outside the frame are dropped. The raster must be exactly rasterW * rasterH entries.
export function fromRaster(
  raster: Uint8Array,
  rasterW: number,
  rasterH: number,
  bounds: MaskBounds,
  frameSize: FrameSize,
): FrameMask {
  if (raster.length !== rasterW * rasterH) {
    throw new Error(`fromRaster: raster has ${raster.length} entries, expected ${rasterW * rasterH}`);
  }
  const out = emptyMask(frameSize);
  for (let y = 0; y < rasterH; y++) {
    const fy = bounds.top + y;
    if (fy < 0 || fy >= frameSize.h) continue;
    for (let x = 0; x < rasterW; x++) {
      if (raster[y * rasterW + x] !== 1) continue;
      const fx = bounds.left + x;
      if (fx < 0 || fx >= frameSize.w) continue;
      out.data[fy * frameSize.w + fx] = 1;
    }
  }
  return out;
}

// Decode one cached SAM record into a full-frame mask.
export function fromRecord(record: MaskRecord, frameSize: FrameSize): FrameMask {
  const raster = decodeMaskToRaster(record.mask);
  return fromRaster(raster, record.mask.width, record.mask.height, record.bounds, frameSize);
}

export function area(mask: FrameMask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i] as number;
  return n;
}

function assertSameSize(a: FrameMask, b: FrameMask, op: string): void {
  if (a.w !== b.w || a.h !== b.h) {
    throw new Error(`${op}: size mismatch ${a.w}x${a.h} vs ${b.w}x${b.h}`);
  }
}

export function intersectArea(a: FrameMask, b: FrameMask): number {
  assertSameSize(a, b, "intersectArea");
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] === 1 && b.data[i] === 1) n++;
  return n;
}

export function union(masks: readonly FrameMask[]): FrameMask {
  const first = masks[0];
  if (first === undefined) throw new Error("union: no masks");
  const out: FrameMask = { w: first.w, h: first.h, data: new Uint8Array(first.data) };
  for (let m = 1; m < masks.length; m++) {
    const mask = masks[m] as FrameMask;
    assertSameSize(out, mask, "union");
    for (let i = 0; i < out.data.length; i++) if (mask.data[i] === 1) out.data[i] = 1;
  }
  return out;
}

// Square dilation by k pixels, computed as two separable passes with running window sums,
// so cost is linear in the frame area regardless of k. k = 0 returns a copy.
export function dilate(mask: FrameMask, k: number): FrameMask {
  if (!Number.isInteger(k) || k < 0) throw new Error(`dilate: k must be a non-negative integer, got ${k}`);
  const { w, h } = mask;
  if (k === 0) return { w, h, data: new Uint8Array(mask.data) };
  const tmp = new Uint8Array(w * h);
  const prefix = new Int32Array(Math.max(w, h) + 1);
  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    prefix[0] = 0;
    for (let x = 0; x < w; x++) prefix[x + 1] = (prefix[x] as number) + (mask.data[row + x] as number);
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - k);
      const hi = Math.min(w, x + k + 1);
      tmp[row + x] = (prefix[hi] as number) - (prefix[lo] as number) > 0 ? 1 : 0;
    }
  }
  // Vertical pass.
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    prefix[0] = 0;
    for (let y = 0; y < h; y++) prefix[y + 1] = (prefix[y] as number) + (tmp[y * w + x] as number);
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - k);
      const hi = Math.min(h, y + k + 1);
      out[y * w + x] = (prefix[hi] as number) - (prefix[lo] as number) > 0 ? 1 : 0;
    }
  }
  return { w, h, data: out };
}

// Half-open bounding box of the set pixels, or null for an empty mask.
export function bbox(mask: FrameMask): MaskBounds | null {
  let left = mask.w, top = mask.h, right = -1, bottom = -1;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (mask.data[y * mask.w + x] !== 1) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  return { left, top, right: right + 1, bottom: bottom + 1 };
}
