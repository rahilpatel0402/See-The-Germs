// Turns cached SAM track files plus the entity table into the engine's Tracks input.
// One entity per SAM class for now: all records of a phrase in a frame are unioned, which is
// the PLAN.md 6.1 fallback ("hands of P1"). Per-hand entities come later if the clips need them.
// Objects persist across detection gaps (engine/persistence.ts); hands never do. Frames are
// decoded on demand with a small cache: a full-frame raster per entity per frame for a whole
// clip would be gigabytes.
import { GAP_FILL_CONFIG } from "../engine/config.ts";
import { fromRecord, union } from "../engine/masks.ts";
import { fillObjectGaps } from "../engine/persistence.ts";
import { isHand } from "../engine/gloves.ts";
import type { Entity, FrameMask, MaskBounds, MaskRecord, Tracks } from "../engine/types.ts";
import { readMeta } from "./clips.ts";
import { passesConfidence, readEntities, type EntityConfig } from "./entities.ts";
import { readTrack } from "./sam.ts";

// Frames kept decoded at once. The engine walks forward and looks back at most ten frames.
const FRAME_CACHE_SIZE = 24;

// Records for one entity: confidence applied, and for objects, gaps filled and marked inferred.
export function entityRecords(entity: EntityConfig, records: readonly MaskRecord[], frameCount: number): MaskRecord[] {
  const kept = records.filter((r) => passesConfidence(entity, r));
  return isHand(entity) ? kept : fillObjectGaps(kept, frameCount, GAP_FILL_CONFIG);
}

// What the client needs to draw the overlay: raw records per entity, the same records the
// engine sees (inferred ones flagged), payloads left encoded so the browser decodes lazily.
export interface TracksPayload {
  readonly frameSize: { readonly w: number; readonly h: number };
  readonly fps: number;
  readonly frames: number;
  readonly entities: readonly Entity[];
  readonly tracks: Readonly<Record<string, readonly MaskRecord[]>>;
}

export async function tracksPayload(clipId: string): Promise<TracksPayload> {
  const meta = await readMeta(clipId);
  const entities = await readEntities(clipId);
  const tracks: Record<string, MaskRecord[]> = {};
  for (const entity of entities) {
    const track = await readTrack(clipId, entity.samPhrase);
    if (!track) continue;
    tracks[entity.id] = entityRecords(entity, track.records, meta.sampled.frames);
  }
  return { frameSize: { w: meta.sampled.width, h: meta.sampled.height }, fps: meta.fps, frames: meta.sampled.frames, entities: plainEntities(entities), tracks };
}

export function plainEntities(entities: readonly EntityConfig[]): Entity[] {
  return entities.map(({ id, label, class: cls, zone, samPhrase, person, agent, aseptic }) => ({
    id,
    label,
    class: cls,
    zone,
    samPhrase,
    ...(person === undefined ? {} : { person }),
    ...(agent === undefined ? {} : { agent }),
    ...(aseptic === undefined ? {} : { aseptic }),
  }));
}

export interface LoadedTracks {
  readonly tracks: Tracks;
  readonly entities: readonly EntityConfig[];
  readonly missingPhrases: readonly string[];
}

const EMPTY_FRAME: ReadonlyMap<string, FrameMask> = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();

export async function loadTracks(clipId: string): Promise<LoadedTracks> {
  const meta = await readMeta(clipId);
  const entities = await readEntities(clipId);
  const frameSize = { w: meta.sampled.width, h: meta.sampled.height };
  const frameCount = meta.sampled.frames;
  const missing: string[] = [];

  // entity id -> frame index -> records (small: encoded payloads only).
  const byEntity = new Map<string, Map<number, MaskRecord[]>>();
  const inferredByFrame = new Map<number, Set<string>>();
  for (const entity of entities) {
    const track = await readTrack(clipId, entity.samPhrase);
    if (!track) {
      missing.push(entity.samPhrase);
      continue;
    }
    const perFrame = new Map<number, MaskRecord[]>();
    for (const record of entityRecords(entity, track.records, frameCount)) {
      (perFrame.get(record.frameIndex) ?? perFrame.set(record.frameIndex, []).get(record.frameIndex)!).push(record);
      if (record.inferred) (inferredByFrame.get(record.frameIndex) ?? inferredByFrame.set(record.frameIndex, new Set()).get(record.frameIndex)!).add(entity.id);
    }
    byEntity.set(entity.id, perFrame);
  }

  const cache = new Map<number, ReadonlyMap<string, FrameMask>>();
  const masksAt = (frameIndex: number): ReadonlyMap<string, FrameMask> => {
    const hit = cache.get(frameIndex);
    if (hit) return hit;
    let frame: Map<string, FrameMask> | null = null;
    for (const [entityId, perFrame] of byEntity) {
      const records = perFrame.get(frameIndex);
      if (!records) continue;
      (frame ??= new Map()).set(entityId, union(records.map((r) => fromRecord(r, frameSize))));
    }
    const result = frame ?? EMPTY_FRAME;
    cache.set(frameIndex, result);
    if (cache.size > FRAME_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return result;
  };

  // Bounds without decoding: the union box of an entity's records in a frame.
  const boundsAt = (frameIndex: number): ReadonlyMap<string, MaskBounds> => {
    const out = new Map<string, MaskBounds>();
    for (const [entityId, perFrame] of byEntity) {
      const records = perFrame.get(frameIndex);
      if (!records || records.length === 0) continue;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const r of records) {
        left = Math.min(left, r.bounds.left);
        top = Math.min(top, r.bounds.top);
        right = Math.max(right, r.bounds.right);
        bottom = Math.max(bottom, r.bounds.bottom);
      }
      out.set(entityId, { left, top, right, bottom });
    }
    return out;
  };

  const inferredAt = (frameIndex: number): ReadonlySet<string> => inferredByFrame.get(frameIndex) ?? EMPTY_SET;

  const tracks: Tracks = { frameSize, fps: meta.fps, frameCount, entities: plainEntities(entities), masksAt, boundsAt, inferredAt };
  return { tracks, entities, missingPhrases: missing };
}
