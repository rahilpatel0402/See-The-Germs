// One code path from cached tracks to the engine's inputs and outputs, shared by analysis,
// counterfactual, and narrative. No model calls here; adjudications are read as input.
import { CONTACT_CONFIG, GLOVE_CONFIG, HYGIENE_CONFIG, SCORE_WEIGHTS } from "../engine/config.ts";
import { detectContacts } from "../engine/contacts.ts";
import { detectGloveEvents } from "../engine/gloves.ts";
import { splitHygiene } from "../engine/hygiene.ts";
import { detectMomentMisses } from "../engine/moments.ts";
import { isPathogenId, PATHOGENS } from "../engine/pathogens.ts";
import { propagate, type PropagationInput } from "../engine/propagation.ts";
import { scoreExposure } from "../engine/score.ts";
import type { Adjudication, Analysis, ContactEvent, Scenario } from "../engine/types.ts";
import { readAdjudications, readScenario, validateScenario } from "./analysis.ts";
import { HttpError } from "./errors.ts";
import { loadTracks } from "./tracks.ts";

export interface Pipeline {
  readonly analysis: Analysis;
  readonly propInput: PropagationInput;
}

export type ScenarioOverride = { pathogen?: Scenario["pathogen"]; sourceEntityId?: string };

export function parseScenarioOverride(body: { pathogen?: unknown; sourceEntityId?: unknown } | undefined): ScenarioOverride {
  const override: ScenarioOverride = {};
  if (body?.pathogen !== undefined) {
    if (typeof body.pathogen !== "string" || !isPathogenId(body.pathogen)) throw new HttpError(400, "pathogen must be one of mrsa, c_auris, c_difficile, norovirus");
    override.pathogen = body.pathogen;
  }
  if (body?.sourceEntityId !== undefined) {
    if (typeof body.sourceEntityId !== "string") throw new HttpError(400, "sourceEntityId must be a string");
    override.sourceEntityId = body.sourceEntityId;
  }
  return override;
}

export function contactsFromCandidates(candidates: Analysis["candidates"], adjudications: readonly Adjudication[]): ContactEvent[] {
  const verdictFor = new Map(adjudications.map((a) => [a.candidateId, a.verdict]));
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
  return contacts;
}

export async function buildPipeline(clipId: string, override: ScenarioOverride = {}): Promise<Pipeline> {
  const { tracks, missingPhrases } = await loadTracks(clipId);
  if (missingPhrases.length > 0) {
    throw new HttpError(409, `clip ${clipId} is not segmented for: ${missingPhrases.join(", ")}. Run segmentation first.`);
  }
  const stored = await readScenario(clipId);
  const scenario = validateScenario({ ...stored, ...override }, new Set(tracks.entities.map((e) => e.id)));
  const profile = PATHOGENS[scenario.pathogen];

  const candidates = detectContacts(tracks, CONTACT_CONFIG);
  const adjudications = await readAdjudications(clipId);
  const contacts = contactsFromCandidates(candidates, adjudications);
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
  return { analysis, propInput };
}
