// Glove on and off from the handover between the bare hand and gloved hand SAM classes of one
// person. A don is the gloved track appearing where the bare track just was; a doff is the
// reverse, or a new bare-hand object being born on the gloved hand: SAM keeps following the
// glove after it comes off, so the gloved track rarely vanishes on a real doff (measured on
// outside footage, Oct 31). Detected only; the manual fallback is a separate path.

import type { GloveConfig } from "./config.ts";
import { bbox } from "./masks.ts";
import type { Entity, GloveEvent, MaskBounds, MaskRecord, ObjectBirth, Tracks } from "./types.ts";

interface Point {
  readonly x: number;
  readonly y: number;
}

export function personOf(entity: Entity): string {
  return entity.person ?? "P1";
}

// The two hand classes. Everything else is a surface, a resident zone, or a dispenser.
export function isHand(entity: { readonly class: Entity["class"] }): boolean {
  return entity.class === "bare_hand" || entity.class === "gloved_hand";
}

function centerOfBounds(box: MaskBounds | null | undefined): Point | undefined {
  if (!box) return undefined;
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Boxes of objects first seen in each frame, where "first seen" includes a return after at
// least gapFrames without a record: SAM reuses ids for a hand that leaves and comes back, and
// skin reappearing after a glove comes off is such a return. Pure; the server feeds the result
// to Tracks.objectBirthsAt.
export function objectBirths(records: readonly MaskRecord[], gapFrames: number): Map<number, ObjectBirth[]> {
  const sorted = [...records].sort((a, b) => a.frameIndex - b.frameIndex || a.objectId.localeCompare(b.objectId));
  const lastSeen = new Map<string, number>();
  const out = new Map<number, ObjectBirth[]>();
  for (const r of sorted) {
    const prev = lastSeen.get(r.objectId);
    if (prev === undefined || r.frameIndex - prev > gapFrames) {
      const birth: ObjectBirth = { box: r.bounds, returning: prev !== undefined };
      const list = out.get(r.frameIndex);
      if (list) list.push(birth);
      else out.set(r.frameIndex, [birth]);
    }
    lastSeen.set(r.objectId, r.frameIndex);
  }
  return out;
}

export function detectGloveEvents(tracks: Tracks, config: GloveConfig): GloveEvent[] {
  const persons = new Map<string, { bare?: Entity; gloved?: Entity }>();
  for (const entity of tracks.entities) {
    if (entity.class !== "bare_hand" && entity.class !== "gloved_hand") continue;
    const p = personOf(entity);
    const slot = persons.get(p) ?? {};
    if (entity.class === "bare_hand") slot.bare = entity;
    else slot.gloved = entity;
    persons.set(p, slot);
  }

  const maxFrame = tracks.frameCount - 1;
  const maxDistance = config.maxHandoverDistanceFraction * tracks.frameSize.w;
  const boxCache = new Map<string, readonly MaskBounds[]>();
  // Per-object boxes of an entity in a frame: from the source when it tells objects apart, else
  // the union box, else the decoded mask's box. No mask decoding when bounds are offered.
  const boxesOf = (entityId: string, f: number): readonly MaskBounds[] => {
    if (f < 0 || f > maxFrame) return [];
    const key = `${entityId}@${f}`;
    let boxes = boxCache.get(key);
    if (boxes === undefined) {
      const perObject = tracks.objectBoundsAt?.(f).get(entityId);
      if (perObject !== undefined && perObject.length > 0) boxes = perObject;
      else if (tracks.boundsAt) {
        const b = tracks.boundsAt(f).get(entityId);
        boxes = b ? [b] : [];
      } else {
        const b = bbox(tracks.masksAt(f).get(entityId) ?? { w: 0, h: 0, data: new Uint8Array(0) });
        boxes = b ? [b] : [];
      }
      boxCache.set(key, boxes);
    }
    return boxes;
  };
  const presentAt = (entityId: string, f: number): boolean => boxesOf(entityId, f).length > 0;
  // Objects first seen in frame f. When the source cannot tell objects apart, a track starting
  // after an absence stands in for a birth.
  const birthsOf = (entityId: string, f: number): readonly ObjectBirth[] => {
    if (tracks.objectBirthsAt) return tracks.objectBirthsAt(f).get(entityId) ?? [];
    return presentAt(entityId, f) && !presentAt(entityId, f - 1) ? boxesOf(entityId, f).map((box) => ({ box, returning: false })) : [];
  };
  const persists = (entityId: string, from: number, frames: number): boolean => {
    if (from + frames - 1 > maxFrame) return false;
    for (let f = from; f < from + frames; f++) if (!presentAt(entityId, f)) return false;
    return true;
  };
  const near = (box: MaskBounds, others: readonly MaskBounds[]): boolean => {
    const c = centerOfBounds(box) as Point;
    return others.some((o) => distance(c, centerOfBounds(o) as Point) <= maxDistance);
  };
  const nearAny = (boxes: readonly MaskBounds[], others: readonly MaskBounds[]): boolean => boxes.some((b) => near(b, others));

  const events: GloveEvent[] = [];
  for (const [, { bare, gloved }] of persons) {
    if (bare === undefined || gloved === undefined) continue;
    const push = (type: GloveEvent["type"], f: number) => events.push({ handId: bare.id, t: f / tracks.fps, type, source: "detected" });
    let gloveOn = false;
    let absentRun = 0;
    // First frame of the current absence of the gloved track while a glove is on, or null.
    let absentStart: number | null = null;
    let lastGlovedBoxes: readonly MaskBounds[] = [];
    let lastGlovedFrame = -1;

    for (let f = 0; f <= maxFrame; f++) {
      const gBoxes = boxesOf(gloved.id, f);

      // Gloves already on when the clip starts: reported as a don at 0 so hand state is right.
      if (f === 0 && gBoxes.length > 0 && persists(gloved.id, 0, config.openFrames)) {
        push("don", 0);
        gloveOn = true;
      }

      // Don: a gloved object born where a bare hand was seen within the handover window. The
      // bare track may keep running through the glove, so only the gloved birth matters.
      if (f > 0) {
        for (const birth of birthsOf(gloved.id, f)) {
          // A glove object that comes back after a gap is SAM re-latching a removed glove's id
          // onto the bare hands (clip C of the shoot: the yellow gloves' ids returned on skin
          // during the next rub). A fresh pair of gloves is a new object. Only new objects don.
          if (birth.returning) continue;
          if (!persists(gloved.id, f, config.openFrames)) break;
          // The bare hand was seen beside the new glove within the window, or it left view just
          // before the glove appeared (the hands dipped out of frame to glove, clip C of the shoot)
          // and no bare hand is visible now.
          let bareSeen = false;
          let bareRecently = false;
          for (let j = f - config.handoverWindowFrames; j <= f && !bareSeen; j++) {
            const boxes = boxesOf(bare.id, j);
            if (boxes.length > 0 && j < f) bareRecently = true;
            bareSeen = near(birth.box, boxes);
          }
          if (!bareSeen && !(bareRecently && !presentAt(bare.id, f))) continue;
          if (!gloveOn) {
            push("don", f);
            gloveOn = true;
          } else if (absentStart !== null) {
            // A fresh handover while the earlier glove had left view: that glove came off out of
            // camera, so it is closed at the start of its absence.
            push("doff", absentStart);
            push("don", f);
          }
          // A second glove on the other hand while one is already on changes nothing.
          absentStart = null;
          break;
        }
      }

      // Doff: a bare-hand object born on the gloved hand. SAM keeps following the glove after it
      // comes off, so the gloved track rarely vanishes on a real doff; the skin coming back is
      // the signal. The gloved hand's last boxes within closeFrames cover a one-frame dropout.
      if (gloveOn) {
        const reference = gBoxes.length > 0 ? gBoxes : f - lastGlovedFrame <= config.closeFrames ? lastGlovedBoxes : [];
        if (reference.length > 0) {
          for (const birth of birthsOf(bare.id, f)) {
            if (!persists(bare.id, f, config.closeFrames)) break;
            if (near(birth.box, reference)) {
              push("doff", f);
              gloveOn = false;
              absentStart = null;
              break;
            }
          }
        }
      }

      // The gloved track leaving view while a glove is on: if the bare hand shows up where the
      // glove was within the handover window, the glove came off there.
      if (gBoxes.length > 0) {
        absentRun = 0;
        lastGlovedBoxes = gBoxes;
        lastGlovedFrame = f;
      } else if (gloveOn) {
        absentRun++;
        if (absentRun === config.closeFrames) {
          absentStart = f - config.closeFrames + 1;
          let bareBack = false;
          for (let j = absentStart; j < absentStart + config.handoverWindowFrames && !bareBack; j++) bareBack = nearAny(boxesOf(bare.id, j), lastGlovedBoxes);
          if (bareBack) {
            push("doff", absentStart);
            gloveOn = false;
            absentStart = null;
          }
        }
      }
    }
  }

  events.sort((a, b) => a.t - b.t || a.handId.localeCompare(b.handId));
  return events;
}
