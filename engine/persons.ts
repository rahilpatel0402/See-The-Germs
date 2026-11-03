// Assigns SAM hand objects to people. SAM tracks "bare hand" and "gloved hand" as classes, not
// as whose hands they are, so with two caregivers in frame, or a resident played by a helper,
// every hand lands on one person. A "person" track from SAM gives one box per person per frame;
// each hand object is assigned by majority vote to the person whose box holds it, and hands that
// belong to a person lying in the resident zone are the resident's, not a caregiver's. Pure.

import type { MaskBounds, MaskRecord } from "./types.ts";

export interface PersonConfig {
  // Heuristic: a person object is the resident when at least this fraction of its frames have
  // most of its own box (this fraction of its area) lying on resident-zone records. A person
  // lying in bed sits inside the sheet and gown; a caregiver leaning over the bed does not.
  readonly residentFrameFraction: number;
  readonly residentCoverOfPersonArea: number;
  // Heuristic: and the person lies down: box height over width at most this. A standing or
  // leaning caregiver is taller than wide; a resident in bed is wider than tall.
  readonly residentMaxHeightOverWidth: number;
}

export const PERSON_CONFIG: PersonConfig = { residentFrameFraction: 0.5, residentCoverOfPersonArea: 0.6, residentMaxHeightOverWidth: 0.8 };

export const RESIDENT_PERSON = "resident";

function center(b: MaskBounds): { x: number; y: number } {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

function contains(outer: MaskBounds, p: { x: number; y: number }): boolean {
  return p.x >= outer.left && p.x < outer.right && p.y >= outer.top && p.y < outer.bottom;
}

function area(b: MaskBounds): number {
  return Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
}

function intersection(a: MaskBounds, b: MaskBounds): number {
  const iw = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const ih = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return iw * ih;
}

function byFrame(records: readonly MaskRecord[]): Map<number, MaskRecord[]> {
  const m = new Map<number, MaskRecord[]>();
  for (const r of records) {
    const list = m.get(r.frameIndex);
    if (list) list.push(r);
    else m.set(r.frameIndex, [r]);
  }
  return m;
}

// Person object ids in the order they are named: first seen first, then leftmost. P1 is the
// first caregiver, P2 the second. Person objects that lie on the resident zone are the resident.
export function labelPersons(persons: readonly MaskRecord[], residents: readonly MaskRecord[], config: PersonConfig): ReadonlyMap<string, string> {
  const first = new Map<string, MaskRecord>();
  const frames = new Map<string, number>();
  const residentFrames = new Map<string, number>();
  const residentsByFrame = byFrame(residents);
  for (const r of persons) {
    const seen = first.get(r.objectId);
    if (seen === undefined || r.frameIndex < seen.frameIndex || (r.frameIndex === seen.frameIndex && r.bounds.left < seen.bounds.left)) first.set(r.objectId, r);
    frames.set(r.objectId, (frames.get(r.objectId) ?? 0) + 1);
    const lying = r.bounds.right - r.bounds.left > 0 && (r.bounds.bottom - r.bounds.top) / (r.bounds.right - r.bounds.left) <= config.residentMaxHeightOverWidth;
    const onResident = lying && area(r.bounds) > 0 && (residentsByFrame.get(r.frameIndex) ?? []).some((z) => intersection(r.bounds, z.bounds) / area(r.bounds) >= config.residentCoverOfPersonArea);
    if (onResident) residentFrames.set(r.objectId, (residentFrames.get(r.objectId) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  const order = [...first.values()].sort((a, b) => a.frameIndex - b.frameIndex || a.bounds.left - b.bounds.left || a.objectId.localeCompare(b.objectId));
  let n = 0;
  for (const p of order) {
    const total = frames.get(p.objectId) ?? 0;
    const onResident = (residentFrames.get(p.objectId) ?? 0) / Math.max(1, total) >= config.residentFrameFraction;
    labels.set(p.objectId, onResident ? RESIDENT_PERSON : `P${++n}`);
  }
  return labels;
}

// hand object id -> person label. A hand whose center falls inside no person box in most of
// its frames stays with P1, the default caregiver, so a clip where the person track failed
// behaves as before.
export function assignHandObjects(
  hands: readonly MaskRecord[],
  persons: readonly MaskRecord[],
  personLabels: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const personsByFrame = byFrame(persons);
  const votes = new Map<string, Map<string, number>>();
  for (const h of hands) {
    const c = center(h.bounds);
    // The smallest person box holding the hand center wins the frame: two people overlapping
    // in the picture are told apart by whichever is tighter around the hand.
    let best: MaskRecord | undefined;
    for (const p of personsByFrame.get(h.frameIndex) ?? []) {
      if (!contains(p.bounds, c)) continue;
      if (best === undefined || area(p.bounds) < area(best.bounds)) best = p;
    }
    const label = best === undefined ? undefined : personLabels.get(best.objectId);
    if (label === undefined) continue;
    const tally = votes.get(h.objectId) ?? new Map<string, number>();
    tally.set(label, (tally.get(label) ?? 0) + 1);
    votes.set(h.objectId, tally);
  }
  const out = new Map<string, string>();
  for (const h of hands) {
    if (out.has(h.objectId)) continue;
    const tally = votes.get(h.objectId);
    let label = "P1";
    if (tally) {
      let bestCount = -1;
      for (const [l, count] of [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (count > bestCount) {
          bestCount = count;
          label = l;
        }
      }
    }
    out.set(h.objectId, label);
  }
  return out;
}
