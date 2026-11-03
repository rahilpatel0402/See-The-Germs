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
import { assignHandObjects, labelPersons, PERSON_CONFIG, RESIDENT_PERSON } from "../engine/persons.ts";
import type { Entity, FrameMask, MaskBounds, MaskRecord, Tracks } from "../engine/types.ts";
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

// Every entity's records exactly as the engine, the overlay, and the adjudication images see
// them: confidence applied, object gaps filled (never across a cut), and, when the clip has
// more than one person, each hand object assigned to the person holding it. Hands of a second
// caregiver become their own entities with person "P2"; hands of a person lying on the resident
// zone are the resident's and are dropped.
export async function loadEntityTracks(clipId: string, meta: ClipMeta, entities: readonly EntityConfig[]): Promise<{ tracks: EntityTrack[]; missingPhrases: string[] }> {
  const frameCount = meta.sampled.frames;
  const cuts = meta.cuts ?? [];
  const missing: string[] = [];
  const raw = new Map<string, readonly MaskRecord[]>();
  for (const entity of entities) {
    const track = await readTrack(clipId, entity.samPhrase);
    if (!track) {
      missing.push(entity.samPhrase);
      continue;
    }
    raw.set(entity.id, track.records);
  }
  const persons = meta.multiPerson ? await readTrack(clipId, PERSON_PHRASE) : null;
  let handOwner: ReadonlyMap<string, string> | null = null;
  if (persons) {
    const residentRecords = entities.filter((e) => e.class === "resident_zone").flatMap((e) => (raw.get(e.id) ?? []).filter((r) => passesConfidence(e, r)));
    const labels = labelPersons(persons.records, residentRecords, PERSON_CONFIG);
    const handRecords = entities.filter(isHand).flatMap((e) => (raw.get(e.id) ?? []).filter((r) => passesConfidence(e, r)).map((r) => ({ ...r, objectId: `${e.id}|${r.objectId}` })));
    const people = new Set(labels.values());
    people.delete(RESIDENT_PERSON);
    if (people.size === 0) {
      // A person track that found nobody standing must not erase the analysis: fall back to
      // one caregiver, as if the flag were off.
      console.log(`persons | ${clipId} | person track found no caregiver (${labels.size} person object${labels.size === 1 ? "" : "s"}, all on the resident zone); hands kept as one caregiver`);
    } else {
      handOwner = assignHandObjects(handRecords, persons.records, labels);
      console.log(`persons | ${clipId} | ${people.size} caregiver${people.size === 1 ? "" : "s"} in frame${labels.size > people.size ? ", plus the resident" : ""}; hand objects assigned by person box`);
    }
  }

  const out: EntityTrack[] = [];
  for (const entity of entities) {
    const records = raw.get(entity.id);
    if (!records) continue;
    if (!isHand(entity) || handOwner === null) {
      out.push({ entity, records: entityRecords(entity, records, frameCount, cuts) });
      continue;
    }
    const kept = records.filter((r) => passesConfidence(entity, r));
    const byPerson = new Map<string, MaskRecord[]>();
    for (const r of kept) {
      const owner = handOwner.get(`${entity.id}|${r.objectId}`) ?? "P1";
      if (owner === RESIDENT_PERSON) continue;
      const list = byPerson.get(owner);
      if (list) list.push(r);
      else byPerson.set(owner, [r]);
    }
    const base = entity.person ?? "P1";
    for (const person of [...byPerson.keys()].sort()) {
      const personRecords = byPerson.get(person) as MaskRecord[];
      if (person === base) out.push({ entity, records: personRecords });
      else {
        const n = Number(person.replace(/\D/g, "")) || 2;
        out.push({ entity: { ...entity, id: `${entity.id}_${person.toLowerCase()}`, label: `${entity.label} (caregiver ${n})`, person }, records: personRecords });
      }
    }
    if (!byPerson.has(base)) out.push({ entity, records: [] });
  }
  return { tracks: out, missingPhrases: missing };
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
  const birthsByFrame = new Map<number, Map<string, MaskBounds[]>>();
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
      // Births from the raw track of the phrase, restricted to the objects this entity kept.
      const rawRecords = (await readTrack(clipId, entity.samPhrase))?.records ?? [];
      const mine = new Set(records.map((r) => r.objectId));
      const firstFrame = new Map<string, MaskRecord>();
      for (const record of rawRecords) {
        if (!mine.has(record.objectId)) continue;
        const seen = firstFrame.get(record.objectId);
        if (seen === undefined || record.frameIndex < seen.frameIndex) firstFrame.set(record.objectId, record);
      }
      for (const record of firstFrame.values()) getOrInit(getOrInit(birthsByFrame, record.frameIndex, () => new Map<string, MaskBounds[]>()), entity.id, () => []).push(record.bounds);
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
  const objectBirthsAt = (frameIndex: number): ReadonlyMap<string, readonly MaskBounds[]> => birthsByFrame.get(frameIndex) ?? EMPTY_BIRTHS;
  const objectBoundsAt = (frameIndex: number): ReadonlyMap<string, readonly MaskBounds[]> => objectBoxesByFrame.get(frameIndex) ?? EMPTY_BIRTHS;

  const effective = resolved.tracks.map((t) => t.entity);
  const tracks: Tracks = { frameSize, fps: meta.fps, frameCount, entities: plainEntities(effective), masksAt, boundsAt, inferredAt, objectBirthsAt, objectBoundsAt };
  return { tracks, entities: effective, missingPhrases: missing };
}
