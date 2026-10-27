// Contact candidate detection. Pure function of decoded tracks and config: same input, same
// output. It never calls a model and never decides whether an ambiguous candidate is a contact;
// that is the adjudication step's job, and the engine consumes its verdicts as input.

import { dilationPx, scaledFloorPx, type ContactConfig } from "./config.ts";
import { dilate, intersectArea } from "./masks.ts";
import type { ContactCandidate, Entity, FrameMask, Tracks } from "./types.ts";

interface OpenRun {
  startFrame: number;
  lastHitFrame: number;
  hits: number;
  peak: number;
}

interface PairState {
  pendingHits: number;
  pendingStart: number;
  pendingPeak: number;
  run: OpenRun | null;
  misses: number;
}

function isHand(entity: Entity): boolean {
  return entity.class === "bare_hand" || entity.class === "gloved_hand";
}

function newState(): PairState {
  return { pendingHits: 0, pendingStart: 0, pendingPeak: 0, run: null, misses: 0 };
}

function finish(run: OpenRun, handId: string, entityId: string, fps: number, config: ContactConfig, floor: number): ContactCandidate {
  const confident = run.peak >= config.confidentIntersectionFactor * floor && run.hits >= config.confidentDwellFrames;
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

        if (hit) {
          if (state.run !== null) {
            state.run.lastHitFrame = f;
            state.run.hits++;
            if (inter > state.run.peak) state.run.peak = inter;
            state.misses = 0;
          } else {
            if (state.pendingHits === 0) {
              state.pendingStart = f;
              state.pendingPeak = 0;
            }
            state.pendingHits++;
            if (inter > state.pendingPeak) state.pendingPeak = inter;
            if (state.pendingHits >= config.openFrames) {
              state.run = { startFrame: state.pendingStart, lastHitFrame: f, hits: state.pendingHits, peak: state.pendingPeak };
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
