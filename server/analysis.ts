// Runs the engine over cached tracks and writes analysis.json. Pure engine in, JSON out; the
// only I/O is reading caches and writing the result. Adjudications are read as input when present.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { CONTACT_CONFIG, GLOVE_CONFIG, HYGIENE_CONFIG, SCORE_WEIGHTS } from "../engine/config.ts";
import { detectContacts } from "../engine/contacts.ts";
import { detectGloveEvents } from "../engine/gloves.ts";
import { splitHygiene } from "../engine/hygiene.ts";
import { detectMomentMisses } from "../engine/moments.ts";
import { isPathogenId, PATHOGENS } from "../engine/pathogens.ts";
import { propagate, type PropagationInput } from "../engine/propagation.ts";
import { scoreExposure } from "../engine/score.ts";
import type { Adjudication, Analysis, ContactEvent, Scenario } from "../engine/types.ts";
import { readEntities } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { adjudicationsPath, analysisPath, scenarioPath } from "./paths.ts";
import { loadTracks } from "./tracks.ts";

export async function readAdjudications(clipId: string): Promise<Adjudication[]> {
  const file = adjudicationsPath(clipId);
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, "utf8")) as Adjudication[];
}

// The clip's stored scenario, or a default: the first object in patient zone A as the source
// (else the first non-hand entity) and MRSA.
export async function readScenario(clipId: string): Promise<Scenario> {
  const file = scenarioPath(clipId);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as Scenario;
  const entities = await readEntities(clipId);
  const source =
    entities.find((e) => e.class === "object" && e.zone === "patient_zone_A") ??
    entities.find((e) => e.class !== "bare_hand" && e.class !== "gloved_hand" && e.class !== "dispenser");
  if (!source) throw new HttpError(409, `clip ${clipId} has no entity that can be a source`);
  return { sourceEntityId: source.id, pathogen: "mrsa" };
}

export async function writeScenario(clipId: string, scenario: Scenario): Promise<void> {
  await writeFile(scenarioPath(clipId), JSON.stringify(scenario, null, 2));
}

export function validateScenario(value: unknown, entityIds: ReadonlySet<string>): Scenario {
  const v = value as { sourceEntityId?: unknown; pathogen?: unknown };
  if (typeof v?.sourceEntityId !== "string" || !entityIds.has(v.sourceEntityId)) throw new HttpError(400, "sourceEntityId must name an entity in this clip");
  if (typeof v.pathogen !== "string" || !isPathogenId(v.pathogen)) throw new HttpError(400, "pathogen must be one of mrsa, c_auris, c_difficile, norovirus");
  return { sourceEntityId: v.sourceEntityId, pathogen: v.pathogen };
}

export async function runAnalysis(clipId: string, override?: Partial<Scenario>): Promise<Analysis> {
  const { tracks, missingPhrases } = await loadTracks(clipId);
  if (missingPhrases.length > 0) {
    throw new HttpError(409, `clip ${clipId} is not segmented for: ${missingPhrases.join(", ")}. Run segmentation first.`);
  }
  const stored = await readScenario(clipId);
  const scenario = validateScenario({ ...stored, ...override }, new Set(tracks.entities.map((e) => e.id)));
  const profile = PATHOGENS[scenario.pathogen];

  const candidates = detectContacts(tracks, CONTACT_CONFIG);
  const adjudications = await readAdjudications(clipId);
  const verdictFor = new Map(adjudications.map((a) => [a.candidateId, a.verdict]));

  // Confident candidates are contacts. Ambiguous ones are contacts only with a verdict of
  // touching or unclear (fail toward caution). Unadjudicated ambiguous candidates are not contacts yet.
  const contacts: ContactEvent[] = [];
  for (const c of candidates) {
    if (c.confidence === "confident") {
      contacts.push({ handId: c.handId, entityId: c.entityId, startT: c.startT, endT: c.endT, adjudicated: false });
      continue;
    }
    const verdict = verdictFor.get(c.id);
    if (verdict === "touching" || verdict === "unclear") {
      contacts.push({ handId: c.handId, entityId: c.entityId, startT: c.startT, endT: c.endT, adjudicated: true });
    }
  }

  const split = splitHygiene(contacts, tracks.entities, profile, HYGIENE_CONFIG);
  const gloveEvents = detectGloveEvents(tracks, GLOVE_CONFIG);
  const propInput: PropagationInput = {
    contacts: split.contacts,
    hygieneEvents: split.hygieneEvents,
    gloveEvents,
    entities: tracks.entities,
    scenario,
    profile,
  };
  const propagation = propagate(propInput);
  const momentMisses = detectMomentMisses(
    { contacts: split.contacts, hygieneEvents: split.hygieneEvents, entities: tracks.entities },
    propagation,
    (inserted) => propagate({ ...propInput, hygieneEvents: [...split.hygieneEvents, inserted] }),
  );
  const score = scoreExposure(propagation, momentMisses, tracks.entities, scenario.sourceEntityId, SCORE_WEIGHTS);

  const analysis: Analysis = {
    clipId,
    scenario,
    pathogen: profile,
    entities: tracks.entities,
    candidates,
    adjudications,
    contacts,
    hygieneEvents: split.hygieneEvents,
    gloveBoxTouches: split.gloveBoxTouches,
    gloveEvents,
    propagation,
    momentMisses,
    score,
  };
  await writeFile(analysisPath(clipId), JSON.stringify(analysis, null, 2));
  return analysis;
}
