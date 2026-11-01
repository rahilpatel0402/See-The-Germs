// Glove on and off from the handover between the bare hand and gloved hand SAM classes of one
// person. A don is the gloved track appearing where the bare track just was; a doff is the
// reverse, or a new bare-hand object being born on the gloved hand: SAM keeps following the
// glove after it comes off, so the gloved track rarely vanishes on a real doff (measured on
// outside footage, Oct 31). Detected only; the manual fallback is a separate path.

import type { GloveConfig } from "./config.ts";
import { bbox } from "./masks.ts";
import type { Entity, GloveEvent, MaskBounds, Tracks } from "./types.ts";

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
  const birthsOf = (entityId: string, f: number): readonly MaskBounds[] => {
    if (tracks.objectBirthsAt) return tracks.objectBirthsAt(f).get(entityId) ?? [];
    return presentAt(entityId, f) && !presentAt(entityId, f - 1) ? boxesOf(entityId, f) : [];
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
          if (!persists(gloved.id, f, config.openFrames)) break;
          let bareSeen = false;
          for (let j = f - config.handoverWindowFrames; j <= f && !bareSeen; j++) bareSeen = near(birth, boxesOf(bare.id, j));
          if (!bareSeen) continue;
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
            if (near(birth, reference)) {
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
