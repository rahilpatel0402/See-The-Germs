// Glove on and off from the handover between the bare hand and gloved hand SAM classes of one
// person. A don is the gloved track appearing where the bare track just was; a doff is the
// reverse. Detected only; the manual fallback is a separate path.

import type { GloveConfig } from "./config.ts";
import { bbox } from "./masks.ts";
import type { Entity, FrameMask, GloveEvent, Tracks } from "./types.ts";

interface Point {
  readonly x: number;
  readonly y: number;
}

export function personOf(entity: Entity): string {
  return entity.person ?? "P1";
}

function center(mask: FrameMask | undefined): Point | undefined {
  if (mask === undefined) return undefined;
  const box = bbox(mask);
  if (box === null) return undefined;
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
  const centerOf = (entityId: string, f: number): Point | undefined => {
    if (f < 0 || f > maxFrame) return undefined;
    const key = `${entityId}@${f}`;
    if (!centers.has(key)) centers.set(key, center(tracks.masksAt(f).get(entityId)));
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
    let lastGlovedCenter: Point | undefined;

    for (let f = 0; f <= maxFrame; f++) {
      const g = centerOf(gloved.id, f);
      if (g !== undefined) {
        glovedRun++;
        absentRun = 0;
        lastGlovedCenter = g;
        if (glovedRun === 1) {
          runStart = f;
          runChecked = false;
        }
        if (!gloveOn && !runChecked && glovedRun >= config.openFrames) {
          runChecked = true;
          const startCenter = centerOf(gloved.id, runStart);
          if (runStart > 0 && startCenter !== undefined && bareNear(bare.id, runStart - config.handoverWindowFrames, runStart - 1, startCenter)) {
            events.push({ handId: bare.id, t: runStart / tracks.fps, type: "don", source: "detected" });
            gloveOn = true;
          }
        }
      } else {
        glovedRun = 0;
        if (gloveOn && lastGlovedCenter !== undefined) {
          absentRun++;
          if (absentRun === config.closeFrames) {
            const absentStart = f - config.closeFrames + 1;
            if (bareNear(bare.id, absentStart, absentStart + config.handoverWindowFrames - 1, lastGlovedCenter)) {
              events.push({ handId: bare.id, t: absentStart / tracks.fps, type: "doff", source: "detected" });
              gloveOn = false;
            }
          }
        }
      }
    }
  }

  events.sort((a, b) => a.t - b.t || a.handId.localeCompare(b.handId));
  return events;
}
