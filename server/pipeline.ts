// One code path from cached tracks to the engine's inputs and outputs, shared by analysis,
// counterfactual, adjudication, and narrative. No model calls here; adjudications are read as input.
// Candidates and glove events depend only on the tracks and the entity table, never on the
// scenario, so they are cached in memory per clip and invalidated by file modification times.
import { stat } from "node:fs/promises";
import { cleaningList } from "../engine/cleaning.ts";
import { complianceFrom, personMapper } from "../engine/compliance.ts";
import { CONTACT_CONFIG, GLOVE_CONFIG, HYGIENE_CONFIG, SCORE_WEIGHTS } from "../engine/config.ts";
import { detectContacts, mergeHandClassContacts } from "../engine/contacts.ts";
import { detectGloveEvents } from "../engine/gloves.ts";
import { detectGloveIssues } from "../engine/gloverules.ts";
import { splitHygiene } from "../engine/hygiene.ts";
import { detectMoments } from "../engine/moments.ts";
import { isPathogenId, PATHOGENS } from "../engine/pathogens.ts";
import { propagate, type PropagationInput } from "../engine/propagation.ts";
import { scoreExposure } from "../engine/score.ts";
import type { Adjudication, Analysis, ContactCandidate, ContactEvent, Entity, GloveEvent, Scenario } from "../engine/types.ts";
import { readMeta } from "./clips.ts";
import { readEntities, type EntityConfig } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { entitiesPath, metaPath, trackPath } from "./paths.ts";
import { readAdjudications, readScenario, validateScenario } from "./scenario.ts";
import { loadTracks } from "./tracks.ts";

export interface Pipeline {
  readonly analysis: Analysis;
  readonly propInput: PropagationInput;
}

export interface Perception {
  readonly entities: readonly Entity[];
  readonly entityConfigs: readonly EntityConfig[];
  readonly candidates: readonly ContactCandidate[];
  readonly gloveEvents: readonly GloveEvent[];
  readonly clipDurationS: number;
}

export type ScenarioOverride = { pathogen?: Scenario["pathogen"]; sourceEntityId?: string };

export function parseScenarioOverride(body: { pathogen?: unknown; sourceEntityId?: unknown } | undefined): ScenarioOverride {
  const override: ScenarioOverride = {};
  if (body?.pathogen !== undefined && body.pathogen !== "") {
    if (typeof body.pathogen !== "string" || !isPathogenId(body.pathogen)) throw new HttpError(400, "pathogen must be one of mrsa, c_auris, c_difficile, norovirus");
    override.pathogen = body.pathogen;
  }
  if (body?.sourceEntityId !== undefined && body.sourceEntityId !== "") {
    if (typeof body.sourceEntityId !== "string") throw new HttpError(400, "sourceEntityId must be a string");
    override.sourceEntityId = body.sourceEntityId;
  }
  return override;
}

export function hasOverride(override: ScenarioOverride): boolean {
  return override.pathogen !== undefined || override.sourceEntityId !== undefined;
}

export function contactsFromCandidates(candidates: readonly ContactCandidate[], adjudications: readonly Adjudication[]): ContactEvent[] {
  const verdictFor = new Map(adjudications.map((a) => [a.candidateId, a.verdict]));
  const contacts: ContactEvent[] = [];
  for (const c of candidates) {
    if (c.confidence === "confident") {
      contacts.push({ handId: c.handId, entityId: c.entityId, startT: c.startT, endT: c.endT, adjudicated: false, candidateIds: [c.id] });
      continue;
    }
    const verdict = verdictFor.get(c.id);
    if (verdict === "touching" || verdict === "unclear") {
      contacts.push({ handId: c.handId, entityId: c.entityId, startT: c.startT, endT: c.endT, adjudicated: true, candidateIds: [c.id] });
    }
  }
  return contacts;
}

const perceptionCache = new Map<string, { key: string; value: Perception }>();

async function mtime(file: string): Promise<string> {
  try {
    return String((await stat(file)).mtimeMs);
  } catch {
    return "missing";
  }
}

async function perceptionKey(clipId: string, entities: readonly EntityConfig[]): Promise<string> {
  const parts = [await mtime(metaPath(clipId)), await mtime(entitiesPath(clipId))];
  for (const phrase of new Set(entities.map((e) => e.samPhrase))) parts.push(`${phrase}=${await mtime(trackPath(clipId, phrase))}`);
  return parts.join("|");
}

// Candidates and glove events for a clip, from cache when nothing on disk has changed.
export async function perceptionFor(clipId: string): Promise<Perception> {
  const entityConfigs = await readEntities(clipId);
  const key = await perceptionKey(clipId, entityConfigs);
  const cached = perceptionCache.get(clipId);
  if (cached && cached.key === key) return cached.value;

  const meta = await readMeta(clipId);
  const { tracks, missingPhrases } = await loadTracks(clipId);
  if (missingPhrases.length > 0) {
    throw new HttpError(409, `clip ${clipId} is not segmented for: ${missingPhrases.join(", ")}. Run segmentation first.`);
  }
  const started = Date.now();
  const value: Perception = {
    entities: tracks.entities,
    entityConfigs,
    candidates: detectContacts(tracks, CONTACT_CONFIG),
    gloveEvents: detectGloveEvents(tracks, GLOVE_CONFIG),
    clipDurationS: meta.sampled.frames / meta.fps,
  };
  console.log(`engine  | ${clipId} | contacts and gloves over ${tracks.frameCount} frames in ${Date.now() - started} ms (cached until tracks change)`);
  perceptionCache.set(clipId, { key, value });
  return value;
}

export async function buildPipeline(clipId: string, override: ScenarioOverride = {}): Promise<Pipeline> {
  const perception = await perceptionFor(clipId);
  const stored = await readScenario(clipId);
  const scenario = validateScenario({ ...stored, ...override }, perception.entities);
  const profile = PATHOGENS[scenario.pathogen];

  const adjudications = await readAdjudications(clipId);
  // One touch seen by both hand classes of one person is one contact.
  const contacts = mergeHandClassContacts(contactsFromCandidates(perception.candidates, adjudications), perception.entities);
  const split = splitHygiene(contacts, perception.entities, profile, HYGIENE_CONFIG, perception.clipDurationS);
  const propInput: PropagationInput = {
    contacts: split.contacts,
    hygieneEvents: split.hygieneEvents,
    gloveEvents: perception.gloveEvents,
    entities: perception.entities,
    scenario,
    profile,
  };
  const propagation = propagate(propInput);
  const moments = detectMoments(
    { contacts: split.contacts, hygieneEvents: split.hygieneEvents, entities: perception.entities },
    propagation,
    (inserted) => propagate({ ...propInput, hygieneEvents: [...split.hygieneEvents, inserted] }),
  );
  const gloveIssues = detectGloveIssues({
    contacts: split.contacts,
    hygieneEvents: split.hygieneEvents,
    gloveEvents: perception.gloveEvents,
    entities: perception.entities,
    clipDurationS: perception.clipDurationS,
  });
  const compliance = complianceFrom(moments.opportunities, personMapper(perception.entities));
  const cleaning = cleaningList(propagation, split.contacts, perception.entities, scenario, profile);
  const score = scoreExposure(propagation, moments.misses, perception.entities, scenario.sourceEntityId, SCORE_WEIGHTS);

  const analysis: Analysis = {
    clipId,
    scenario,
    pathogen: profile,
    entities: perception.entities,
    candidates: perception.candidates,
    adjudications,
    contacts,
    hygieneEvents: split.hygieneEvents,
    gloveBoxTouches: split.gloveBoxTouches,
    gloveEvents: perception.gloveEvents,
    gloveIssues,
    propagation,
    opportunities: moments.opportunities,
    momentMisses: moments.misses,
    compliance,
    cleaning,
    score,
  };
  return { analysis, propInput };
}
