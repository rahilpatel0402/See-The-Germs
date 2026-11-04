// Turns cached SAM track files plus the entity table into the engine's Tracks input.
// One entity per SAM class for now: all records of a phrase in a frame are unioned, which is
// the PLAN.md 6.1 fallback ("hands of P1"). Per-hand entities come later if the clips need them.
// Objects persist across detection gaps (engine/persistence.ts); hands never do. Frames are
// decoded on demand with a small cache: a full-frame raster per entity per frame for a whole
// clip would be gigabytes.
import { GAP_FILL_CONFIG } from "../engine/config.ts";
import { fromRecord, union } from "../engine/masks.ts";
import { fillObjectGaps } from "../engine/persistence.ts";
import { isHand, objectBirths } from "../engine/gloves.ts";
import { GLOVE_CONFIG, PERSON_CONFIG } from "../engine/config.ts";
import { assignHandObjects, labelPersons, RESIDENT_PERSON, splitHandsByPerson } from "../engine/persons.ts";
import type { Entity, FrameMask, MaskBounds, MaskRecord, ObjectBirth, Tracks } from "../engine/types.ts";
import { type ClipMeta, readMeta } from "./clips.ts";
import { passesConfidence, readEntities, type EntityConfig } from "./entities.ts";
import { readTrack } from "./sam.ts";

// Frames kept decoded at once. The engine walks forward and looks back at most ten frames.
const FRAME_CACHE_SIZE = 24;

// The SAM phrase tracked alongside the props when a clip has more than one person in frame.
export const PERSON_PHRASE = "person";

export interface EntityTrack {
  readonly entity: EntityConfig;
  readonly records: MaskRecord[];
}

export interface ResolvedTracks {
  readonly tracks: EntityTrack[];
  readonly missingPhrases: string[];
  // Raw SAM records per phrase, as read, for callers that need object births.
  readonly rawByPhrase: ReadonlyMap<string, readonly MaskRecord[]>;
}

// Every entity's records exactly as the engine, the overlay, and the adjudication images see
// them: confidence applied, object gaps filled (never across a cut), and, when the clip has
// more than one person, each hand object assigned to the person holding it. Hands of a second
// caregiver become their own entities with person "P2"; hands of a person lying on the resident
// zone are the resident's and are dropped.
export async function loadEntityTracks(clipId: string, meta: ClipMeta, entities: readonly EntityConfig[]): Promise<ResolvedTracks> {
  const frameCount = meta.sampled.frames;
  const cuts = meta.cuts ?? [];
  const missing: string[] = [];
  const rawByPhrase = new Map<string, readonly MaskRecord[]>();
  const phrases = [...new Set([...entities.map((e) => e.samPhrase), ...(meta.multiPerson ? [PERSON_PHRASE] : [])])];
  for (const phrase of phrases) {
    const track = await readTrack(clipId, phrase);
    if (track) rawByPhrase.set(phrase, track.records);
    else missing.push(phrase);
  }
  // Records as the engine sees them: confidence applied, object gaps filled, never across a cut.
  const prepared = new Map<string, MaskRecord[]>();
  for (const entity of entities) {
    const raw = rawByPhrase.get(entity.samPhrase);
    if (raw) prepared.set(entity.id, entityRecords(entity, raw, frameCount, cuts));
  }
  const present = entities.filter((e) => prepared.has(e.id));

  let owner: ReadonlyMap<string, string> = new Map();
  const persons = meta.multiPerson ? rawByPhrase.get(PERSON_PHRASE) : undefined;
  if (persons) {
    const residentRecords = present.filter((e) => e.class === "resident_zone").flatMap((e) => prepared.get(e.id) ?? []);
    const labels = labelPersons(persons, residentRecords, PERSON_CONFIG);
    const people = new Set(labels.values());
    people.delete(RESIDENT_PERSON);
    if (people.size === 0) {
      // A person track that found nobody standing must not erase the analysis: fall back to
      // one caregiver, as if the flag were off.
      console.log(`persons | ${clipId} | person track found no caregiver (${labels.size} person object${labels.size === 1 ? "" : "s"}, all on the resident zone); hands kept as one caregiver`);
    } else {
      const handRecords = present.filter(isHand).flatMap((e) => (prepared.get(e.id) ?? []).map((r) => ({ ...r, objectId: `${e.id}|${r.objectId}` })));
      owner = assignHandObjects(handRecords, persons, labels);
      console.log(`persons | ${clipId} | ${people.size} caregiver${people.size === 1 ? "" : "s"} in frame${labels.size > people.size ? ", plus the resident" : ""}; hand objects assigned by person box`);
    }
  }
  const split = splitHandsByPerson(plainEntities(present), prepared, owner);
  const configByBase = new Map(present.map((e) => [e.id, e]));
  const tracks: EntityTrack[] = split.map((t) => {
    // Keep the per-clip config (minConfidence) of the entity each split came from.
    const baseId = present.find((e) => t.entity.id === e.id || t.entity.id.startsWith(`${e.id}_`))?.id ?? t.entity.id;
    const base = configByBase.get(baseId);
    return { entity: { ...(base ?? {}), ...t.entity } as EntityConfig, records: t.records };
  });
  return { tracks, missingPhrases: missing, rawByPhrase };
}

// Records for one entity: confidence applied, and for objects, gaps filled and marked inferred.
export function entityRecords(entity: EntityConfig, records: readonly MaskRecord[], frameCount: number, cuts: readonly number[] = []): MaskRecord[] {
  const kept = records.filter((r) => passesConfidence(entity, r));
  return isHand(entity) ? kept : fillObjectGaps(kept, frameCount, GAP_FILL_CONFIG, cuts);
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
  const resolved = await loadEntityTracks(clipId, meta, entities);
  const tracks: Record<string, MaskRecord[]> = {};
  for (const t of resolved.tracks) tracks[t.entity.id] = t.records;
  return { frameSize: { w: meta.sampled.width, h: meta.sampled.height }, fps: meta.fps, frames: meta.sampled.frames, entities: plainEntities(resolved.tracks.map((t) => t.entity)), tracks };
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
const EMPTY_BIRTHS: ReadonlyMap<string, readonly MaskBounds[]> = new Map();
const EMPTY_OBJECT_BIRTHS: ReadonlyMap<string, readonly ObjectBirth[]> = new Map();

export async function loadTracks(clipId: string): Promise<LoadedTracks> {
  const meta = await readMeta(clipId);
  const entities = await readEntities(clipId);
  const frameSize = { w: meta.sampled.width, h: meta.sampled.height };
  const frameCount = meta.sampled.frames;
  const resolved = await loadEntityTracks(clipId, meta, entities);
  const missing = resolved.missingPhrases;

  // entity id -> frame index -> records (small: encoded payloads only).
  const byEntity = new Map<string, Map<number, MaskRecord[]>>();
  const inferredByFrame = new Map<number, Set<string>>();
  // Hands only, for glove handover: frame index -> entity id -> boxes of SAM objects first seen
  // in that frame (from the raw track, before the confidence gate, so a confidence dip never
  // manufactures a birth), and frame index -> entity id -> every object's box.
  const birthsByFrame = new Map<number, Map<string, ObjectBirth[]>>();
  const objectBoxesByFrame = new Map<number, Map<string, MaskBounds[]>>();
  const getOrInit = <K, V>(map: Map<K, V>, key: K, init: () => V): V => {
    const hit = map.get(key);
    if (hit !== undefined) return hit;
    const made = init();
    map.set(key, made);
    return made;
  };
  for (const { entity, records } of resolved.tracks) {
    const perFrame = new Map<number, MaskRecord[]>();
    for (const record of records) {
      getOrInit(perFrame, record.frameIndex, () => []).push(record);
      if (record.inferred) getOrInit(inferredByFrame, record.frameIndex, () => new Set<string>()).add(entity.id);
      else if (isHand(entity)) getOrInit(getOrInit(objectBoxesByFrame, record.frameIndex, () => new Map<string, MaskBounds[]>()), entity.id, () => []).push(record.bounds);
    }
    if (isHand(entity)) {
      // Births from the raw track of the phrase (first sighting, or a return after a gap),
      // restricted to the objects this entity kept.
      const rawRecords = resolved.rawByPhrase.get(entity.samPhrase) ?? [];
      const mine = new Set(records.map((r) => r.objectId));
      for (const [frame, births] of objectBirths(rawRecords.filter((r) => mine.has(r.objectId)), GLOVE_CONFIG.rebirthGapFrames)) {
        getOrInit(getOrInit(birthsByFrame, frame, () => new Map<string, ObjectBirth[]>()), entity.id, () => []).push(...births);
      }
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
  const objectBirthsAt = (frameIndex: number): ReadonlyMap<string, readonly ObjectBirth[]> => birthsByFrame.get(frameIndex) ?? EMPTY_OBJECT_BIRTHS;
  const objectBoundsAt = (frameIndex: number): ReadonlyMap<string, readonly MaskBounds[]> => objectBoxesByFrame.get(frameIndex) ?? EMPTY_BIRTHS;

  const effective = resolved.tracks.map((t) => t.entity);
  const tracks: Tracks = { frameSize, fps: meta.fps, frameCount, entities: plainEntities(effective), masksAt, boundsAt, inferredAt, objectBirthsAt, objectBoundsAt };
  return { tracks, entities: effective, missingPhrases: missing };
}
