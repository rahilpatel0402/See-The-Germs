// Turns cached SAM track files plus the entity table into the engine's Tracks input.
// One entity per SAM class for now: all records of a phrase in a frame are unioned, which is
// the PLAN.md 6.1 fallback ("hands of P1"). Per-hand entities come later if the clips need them.
import { fromRecord, union } from "../engine/masks.ts";
import type { Entity, FrameMask, Tracks } from "../engine/types.ts";
import { readMeta } from "./clips.ts";
import { readEntities, type EntityConfig } from "./entities.ts";
import { readTrack } from "./sam.ts";

export interface LoadedTracks {
  readonly tracks: Tracks;
  readonly entities: readonly EntityConfig[];
  readonly missingPhrases: readonly string[];
}

export async function loadTracks(clipId: string): Promise<LoadedTracks> {
  const meta = await readMeta(clipId);
  const entities = await readEntities(clipId);
  const frameSize = { w: meta.sampled.width, h: meta.sampled.height };
  const frames = new Map<number, Map<string, FrameMask>>();
  const missing: string[] = [];

  for (const entity of entities) {
    const track = await readTrack(clipId, entity.samPhrase);
    if (!track) {
      missing.push(entity.samPhrase);
      continue;
    }
    const perFrame = new Map<number, FrameMask[]>();
    for (const record of track.records) {
      if (entity.minConfidence !== undefined && record.confidence !== undefined && record.confidence < entity.minConfidence) continue;
      const list = perFrame.get(record.frameIndex) ?? [];
      list.push(fromRecord(record, frameSize));
      perFrame.set(record.frameIndex, list);
    }
    for (const [frameIndex, masks] of perFrame) {
      const frame = frames.get(frameIndex) ?? new Map<string, FrameMask>();
      frame.set(entity.id, union(masks));
      frames.set(frameIndex, frame);
    }
  }

  // Every sampled frame exists in the map even when nothing was seen, so maxFrame is the clip length.
  for (let f = 0; f < meta.sampled.frames; f++) if (!frames.has(f)) frames.set(f, new Map());

  const plain: Entity[] = entities.map(({ id, label, class: cls, zone, samPhrase }) => ({ id, label, class: cls, zone, samPhrase }));
  return { tracks: { frameSize, fps: meta.fps, entities: plain, frames }, entities, missingPhrases: missing };
}
