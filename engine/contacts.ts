// Contact candidate detection. Pure function of decoded tracks and config: same input, same
// output. It never calls a model and never decides whether an ambiguous candidate is a contact;
// that is the adjudication step's job, and the engine consumes its verdicts as input.

import { dilationPx, scaledFloorPx, type ContactConfig } from "./config.ts";
import { personOf } from "./gloves.ts";
import { dilate, intersectArea } from "./masks.ts";
import type { ContactCandidate, ContactEvent, Entity, FrameMask, Tracks } from "./types.ts";

// One physical touch can be seen by both SAM hand classes of the same person (a transparent
// glove, or the moment of a handover). Contacts from the bare and gloved classes of one person
// on the same entity that overlap in time are merged into one. The merged contact is attributed
// to the gloved class when either side was gloved, because that is the surface that touched.
export function mergeHandClassContacts(contacts: readonly ContactEvent[], entities: readonly Entity[]): ContactEvent[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const handEntity = (id: string): Entity => {
    const e = byId.get(id);
    if (e === undefined || (e.class !== "bare_hand" && e.class !== "gloved_hand")) throw new Error(`mergeHandClassContacts: ${id} is not a hand`);
    return e;
  };
  const groups = new Map<string, ContactEvent[]>();
  for (const c of contacts) {
    const key = `${personOf(handEntity(c.handId))}|${c.entityId}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  const out: ContactEvent[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.startT - b.startT || a.endT - b.endT);
    let current: ContactEvent | null = null;
    for (const c of sorted) {
      if (current !== null && c.startT <= current.endT) {
        const prev: ContactEvent = current;
        const prevGloved: boolean = handEntity(prev.handId).class === "gloved_hand";
        const thisGloved: boolean = handEntity(c.handId).class === "gloved_hand";
        const handId: string = prevGloved ? prev.handId : thisGloved ? c.handId : prev.handId;
        const ids: string[] = [...(prev.candidateIds ?? []), ...(c.candidateIds ?? [])];
        current = {
          handId,
          entityId: c.entityId,
          startT: prev.startT,
          endT: Math.max(prev.endT, c.endT),
          adjudicated: prev.adjudicated || c.adjudicated,
          ...(ids.length > 0 ? { candidateIds: ids } : {}),
        };
      } else {
        if (current !== null) out.push(current);
        current = c;
      }
    }
    if (current !== null) out.push(current);
  }
  out.sort((a, b) => a.startT - b.startT || a.entityId.localeCompare(b.entityId) || a.handId.localeCompare(b.handId));
  return out;
}

interface OpenRun {
  startFrame: number;
  lastHitFrame: number;
  hits: number;
  peak: number;
  inferred: boolean;
}

interface PairState {
  pendingHits: number;
  pendingStart: number;
  pendingPeak: number;
  pendingInferred: boolean;
  run: OpenRun | null;
  misses: number;
}

function isHand(entity: Entity): boolean {
  return entity.class === "bare_hand" || entity.class === "gloved_hand";
}

function newState(): PairState {
  return { pendingHits: 0, pendingStart: 0, pendingPeak: 0, pendingInferred: false, run: null, misses: 0 };
}

function finish(run: OpenRun, handId: string, entityId: string, fps: number, config: ContactConfig, floor: number): ContactCandidate {
  // A contact resting on an inferred object mask is never confident: the camera did not see
  // the object there, so vision review decides.
  const confident = !run.inferred && run.peak >= config.confidentIntersectionFactor * floor && run.hits >= config.confidentDwellFrames;
  return {
    id: `${handId}:${entityId}:${run.startFrame}`,
    handId,
    entityId,
    startT: run.startFrame / fps,
    endT: (run.lastHitFrame + 1) / fps,
    startFrame: run.startFrame,
    endFrame: run.lastHitFrame,
    confidence: confident ? "confident" : "ambiguous",
    peakIntersectionPx: run.peak,
    dwellFrames: run.hits,
    ...(run.inferred ? { inferredObject: true } : {}),
  };
}

export function detectContacts(tracks: Tracks, config: ContactConfig): ContactCandidate[] {
  const hands = tracks.entities.filter(isHand);
  const targets = tracks.entities.filter((e) => !isHand(e));
  const floor = scaledFloorPx(config, tracks.frameSize);
  const k = dilationPx(config, tracks.frameSize);
  const fps = tracks.fps;
  if (!(fps > 0)) throw new Error(`detectContacts: fps must be positive, got ${fps}`);

  if (!Number.isInteger(tracks.frameCount) || tracks.frameCount < 0) throw new Error(`detectContacts: bad frameCount ${tracks.frameCount}`);

  const states = new Map<string, PairState>();
  const out: ContactCandidate[] = [];

  for (let f = 0; f < tracks.frameCount; f++) {
    const frame = tracks.masksAt(f);
    const inferredHere = tracks.inferredAt?.(f);
    for (const hand of hands) {
      const handMask = frame.get(hand.id);
      const dilated: FrameMask | undefined = handMask === undefined ? undefined : dilate(handMask, k);
      for (const target of targets) {
        const key = `${hand.id}|${target.id}`;
        let state = states.get(key);
        if (state === undefined) {
          state = newState();
          states.set(key, state);
        }
        const targetMask = frame.get(target.id);
        const inter = dilated !== undefined && targetMask !== undefined ? intersectArea(dilated, targetMask) : 0;
        const hit = inter >= floor;
        const inferred = hit && inferredHere !== undefined && inferredHere.has(target.id);

        if (hit) {
          if (state.run !== null) {
            state.run.lastHitFrame = f;
            state.run.hits++;
            if (inter > state.run.peak) state.run.peak = inter;
            if (inferred) state.run.inferred = true;
            state.misses = 0;
          } else {
            if (state.pendingHits === 0) {
              state.pendingStart = f;
              state.pendingPeak = 0;
              state.pendingInferred = false;
            }
            state.pendingHits++;
            if (inter > state.pendingPeak) state.pendingPeak = inter;
            if (inferred) state.pendingInferred = true;
            if (state.pendingHits >= config.openFrames) {
              state.run = { startFrame: state.pendingStart, lastHitFrame: f, hits: state.pendingHits, peak: state.pendingPeak, inferred: state.pendingInferred };
              state.pendingHits = 0;
              state.misses = 0;
            }
          }
        } else if (state.run !== null) {
          state.misses++;
          if (state.misses >= config.closeFrames) {
            out.push(finish(state.run, hand.id, target.id, fps, config, floor));
            state.run = null;
            state.misses = 0;
          }
        } else {
          state.pendingHits = 0;
          state.pendingPeak = 0;
          state.pendingInferred = false;
        }
      }
    }
  }

  // Close runs still open at the end of the clip. Pending runs that never reached openFrames are dropped.
  for (const hand of hands) {
    for (const target of targets) {
      const state = states.get(`${hand.id}|${target.id}`);
      if (state?.run) out.push(finish(state.run, hand.id, target.id, fps, config, floor));
    }
  }

  out.sort((a, b) => a.startFrame - b.startFrame || a.handId.localeCompare(b.handId) || a.entityId.localeCompare(b.entityId));
  return out;
}
