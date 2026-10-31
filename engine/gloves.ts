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
  const centers = new Map<string, Point | undefined>();
  // Centers come from record bounds when the source offers them (no mask decoding), else from
  // the decoded mask's bounding box.
  const centerOf = (entityId: string, f: number): Point | undefined => {
    if (f < 0 || f > maxFrame) return undefined;
    const key = `${entityId}@${f}`;
    if (!centers.has(key)) {
      const box = tracks.boundsAt ? tracks.boundsAt(f).get(entityId) : bbox(tracks.masksAt(f).get(entityId) ?? { w: 0, h: 0, data: new Uint8Array(0) });
      centers.set(key, centerOfBounds(box));
    }
    return centers.get(key);
  };
  const bareNear = (bareId: string, from: number, to: number, target: Point): boolean => {
    for (let f = Math.max(0, from); f <= Math.min(maxFrame, to); f++) {
      const c = centerOf(bareId, f);
      if (c !== undefined && distance(c, target) <= maxDistance) return true;
    }
    return false;
  };

  const events: GloveEvent[] = [];
  for (const [, { bare, gloved }] of persons) {
    if (bare === undefined || gloved === undefined) continue;
    let gloveOn = false;
    let glovedRun = 0;
    let runStart = -1;
    let runChecked = false;
    let absentRun = 0;
    // First frame of the current absence of the gloved track while a glove is on, or null.
    let absentStart: number | null = null;
    let lastGlovedCenter: Point | undefined;

    for (let f = 0; f <= maxFrame; f++) {
      const g = centerOf(gloved.id, f);
      // A bare-hand object born within reach of the gloved hand while a glove is on: the skin
      // just came back into view, which is the doff, whatever the gloved track does next.
      if (gloveOn && g !== undefined && tracks.objectBirthsAt !== undefined) {
        const births = tracks.objectBirthsAt(f).get(bare.id) ?? [];
        if (births.some((box) => distance(centerOfBounds(box) as Point, g) <= maxDistance)) {
          events.push({ handId: bare.id, t: f / tracks.fps, type: "doff", source: "detected" });
          gloveOn = false;
          absentStart = null;
        }
      }
      if (g !== undefined) {
        glovedRun++;
        absentRun = 0;
        lastGlovedCenter = g;
        if (glovedRun === 1) {
          runStart = f;
          runChecked = false;
        }
        if (!runChecked && glovedRun >= config.openFrames) {
          runChecked = true;
          const startCenter = centerOf(gloved.id, runStart);
          const handover = runStart > 0 && startCenter !== undefined && bareNear(bare.id, runStart - config.handoverWindowFrames, runStart - 1, startCenter);
          if (!handover && runStart === 0) {
            // Gloves already on when the clip starts: no don to report, but the glove is worn,
            // so a later doff (bare hand reappearing) is still detected.
            gloveOn = true;
          }
          if (handover) {
            // A fresh bare-to-gloved handover while a glove was still "on" means the earlier
            // glove came off out of view: close it at the start of that absence.
            if (gloveOn && absentStart !== null) {
              events.push({ handId: bare.id, t: absentStart / tracks.fps, type: "doff", source: "detected" });
            }
            if (!gloveOn || absentStart !== null) {
              events.push({ handId: bare.id, t: runStart / tracks.fps, type: "don", source: "detected" });
            }
            gloveOn = true;
            absentStart = null;
          }
        }
      } else {
        glovedRun = 0;
        if (gloveOn && lastGlovedCenter !== undefined) {
          absentRun++;
          if (absentRun === config.closeFrames) absentStart = f - config.closeFrames + 1;
          // The window after the absence is fixed and every frame in it is readable, so the
          // bare-hand check runs once, when the absence is first confirmed.
          if (absentRun === config.closeFrames && absentStart !== null && bareNear(bare.id, absentStart, absentStart + config.handoverWindowFrames - 1, lastGlovedCenter)) {
            events.push({ handId: bare.id, t: absentStart / tracks.fps, type: "doff", source: "detected" });
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
