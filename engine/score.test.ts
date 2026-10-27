import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORE_WEIGHTS } from "./config.ts";
import { CLIP_A_CONTACTS, CLIP_A_ENTITIES } from "./fixtures.ts";
import { detectMomentMisses } from "./moments.ts";
import { PATHOGENS } from "./pathogens.ts";
import { propagate, type PropagationInput } from "./propagation.ts";
import { scoreExposure } from "./score.ts";

const input: PropagationInput = {
  contacts: CLIP_A_CONTACTS,
  hygieneEvents: [],
  gloveEvents: [],
  entities: CLIP_A_ENTITIES,
  scenario: { sourceEntityId: "rail_A", pathogen: "mrsa" },
  profile: PATHOGENS.mrsa,
};

test("clip A scores 3 surfaces, chain length 5, one exposure, two misses, score 23", () => {
  const propagation = propagate(input);
  const misses = detectMomentMisses({ contacts: input.contacts, hygieneEvents: [], entities: input.entities }, propagation, (ins) => propagate({ ...input, hygieneEvents: [ins] }));
  const s = scoreExposure(propagation, misses, input.entities, "rail_A", SCORE_WEIGHTS);
  assert.equal(s.contaminatedSurfaces, 3);
  assert.equal(s.chainLength, 5);
  assert.deepEqual(s.residentExposures, { resident_B: 1 });
  assert.deepEqual(s.momentsMissed, { "1": 1, "2": 0, "4": 0, "5": 1 });
  assert.equal(s.score, 10 * 1 + 3 * 3 + 2 * 2);
});

test("a clean run scores zero: only the source is contaminated", () => {
  const propagation = propagate({ ...input, hygieneEvents: [{ handId: "bare_hand", t: 3, agent: "alcohol_rub", effective: true }] });
  const s = scoreExposure(propagation, [], input.entities, "rail_A", SCORE_WEIGHTS);
  assert.deepEqual(s, { contaminatedSurfaces: 0, chainLength: 1, residentExposures: {}, momentsMissed: { "1": 0, "2": 0, "4": 0, "5": 0 }, score: 0 });
});
