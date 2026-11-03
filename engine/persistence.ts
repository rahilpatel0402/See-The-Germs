// Object persistence across detection gaps. SAM loses an object when a hand covers it, which is
// exactly the moment a contact happens, and sometimes does not find a prop until something
// moves near it. For objects (never hands) the gap is filled from the nearest sighting, and the
// filled records are marked inferred so the contact detector sends anything resting on them to
// vision review instead of trusting them. Pure.

import type { GapFillConfig } from "./config.ts";
import type { MaskBounds, MaskRecord } from "./types.ts";

function unionBounds(records: readonly MaskRecord[]): MaskBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of records) {
    left = Math.min(left, r.bounds.left);
    top = Math.min(top, r.bounds.top);
    right = Math.max(right, r.bounds.right);
    bottom = Math.max(bottom, r.bounds.bottom);
  }
  return { left, top, right, bottom };
}

export function boxIoU(a: MaskBounds, b: MaskBounds): number {
  const iw = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const ih = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = iw * ih;
  const union = (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - inter;
  return union > 0 ? inter / union : 0;
}

function cloneTo(records: readonly MaskRecord[], frameIndex: number): MaskRecord[] {
  return records.map((r) => ({ ...r, frameIndex, inferred: true }));
}

// Fills frames with no record for one object. Input records may span several SAM object ids
// (all records of one entity); every record of a sighting frame is carried together.
// cuts: frame indexes that start a new shot. No fill crosses one: an object seen before a cut
// says nothing about where it is after it (outside footage, Oct 31).
export function fillObjectGaps(records: readonly MaskRecord[], frameCount: number, config: GapFillConfig, cuts: readonly number[] = []): MaskRecord[] {
  if (!config.enabled || records.length === 0 || frameCount <= 0) return [...records];
  const sortedCuts = [...cuts].filter((c) => c > 0 && c < frameCount).sort((a, b) => a - b);
  // Start frame of the shot that contains f, and the first frame after it.
  const shotStart = (f: number): number => sortedCuts.filter((c) => c <= f).at(-1) ?? 0;
  const shotEnd = (f: number): number => sortedCuts.find((c) => c > f) ?? frameCount;
  const crossesCut = (a: number, b: number): boolean => sortedCuts.some((c) => c > a && c <= b);
  const byFrame = new Map<number, MaskRecord[]>();
  for (const r of records) {
    if (r.inferred) continue;
    (byFrame.get(r.frameIndex) ?? byFrame.set(r.frameIndex, []).get(r.frameIndex)!).push(r);
  }
  const seen = [...byFrame.keys()].sort((a, b) => a - b);
  const out: MaskRecord[] = [];
  for (const f of seen) out.push(...(byFrame.get(f) as MaskRecord[]));
  if (seen.length === 0) return out;

  const first = seen[0] as number;
  const last = seen[seen.length - 1] as number;
  if (config.backfillFromFirstSighting) {
    const src = byFrame.get(first) as MaskRecord[];
    for (let f = shotStart(first); f < first; f++) out.push(...cloneTo(src, f));
  }
  if (config.forwardFillToEnd) {
    const src = byFrame.get(last) as MaskRecord[];
    for (let f = last + 1; f < shotEnd(last); f++) out.push(...cloneTo(src, f));
  }
  for (let i = 0; i + 1 < seen.length; i++) {
    const a = seen[i] as number;
    const b = seen[i + 1] as number;
    if (b <= a + 1) continue;
    if (crossesCut(a, b)) {
      // Fill each side up to the cut only, as a moving object would be.
      const before = byFrame.get(a) as MaskRecord[];
      const after = byFrame.get(b) as MaskRecord[];
      const endA = Math.min(shotEnd(a), a + 1 + config.maxMovingGapFrames);
      const startB = Math.max(shotStart(b), b - config.maxMovingGapFrames);
      for (let f = a + 1; f < endA; f++) out.push(...cloneTo(before, f));
      for (let f = startB; f < b; f++) out.push(...cloneTo(after, f));
      continue;
    }
    const before = byFrame.get(a) as MaskRecord[];
    const after = byFrame.get(b) as MaskRecord[];
    const stationary = boxIoU(unionBounds(before), unionBounds(after)) >= config.staticIoU;
    if (stationary) {
      for (let f = a + 1; f < b; f++) out.push(...cloneTo(before, f));
    } else {
      const span = b - a - 1;
      const fromBefore = Math.min(config.maxMovingGapFrames, Math.ceil(span / 2));
      const fromAfter = Math.min(config.maxMovingGapFrames, span - fromBefore);
      for (let f = a + 1; f <= a + fromBefore; f++) out.push(...cloneTo(before, f));
      for (let f = b - fromAfter; f < b; f++) out.push(...cloneTo(after, f));
    }
  }
  out.sort((x, y) => x.frameIndex - y.frameIndex || x.objectId.localeCompare(y.objectId));
  return out;
}
