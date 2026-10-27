import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORE_WEIGHTS } from "./config.ts";
import { runCounterfactual } from "./counterfactual.ts";
import { CLIP_A_CONTACTS, CLIP_A_ENTITIES } from "./fixtures.ts";
import { detectMomentMisses } from "./moments.ts";
import { PATHOGENS } from "./pathogens.ts";
import { propagate, type PropagationInput } from "./propagation.ts";
import { scoreExposure } from "./score.ts";
import type { PathogenId } from "./types.ts";

function baseFor(pathogen: PathogenId) {
  const input: PropagationInput = {
    contacts: CLIP_A_CONTACTS,
    hygieneEvents: [],
    gloveEvents: [],
    entities: CLIP_A_ENTITIES,
    scenario: { sourceEntityId: "rail_A", pathogen },
    profile: PATHOGENS[pathogen],
  };
  const propagation = propagate(input);
  const misses = detectMomentMisses({ contacts: input.contacts, hygieneEvents: [], entities: input.entities }, propagation, (ins) => propagate({ ...input, hygieneEvents: [ins] }));
  const score = scoreExposure(propagation, misses, input.entities, "rail_A", SCORE_WEIGHTS);
  return { input, base: { propagation, score } };
}

test("an alcohol rub at 3 s under MRSA takes clip A from 23 to 2 and keeps five things clean", () => {
  const { input, base } = baseFor("mrsa");
  const cf = runCounterfactual(input, base, { handId: "bare_hand", t: 3, agent: "alcohol_rub" }, SCORE_WEIGHTS);
  assert.equal(cf.before.score, 23);
  // Resident B is still touched after the phone without hygiene, so one Moment 1 miss remains.
  assert.equal(cf.after.score, 2);
  assert.equal(cf.after.contaminatedSurfaces, 0);
  assert.deepEqual(cf.after.residentExposures, {});
  assert.deepEqual([...cf.keptClean].sort(), ["bare_hand", "blanket_B", "gloved_hand", "iv_pole", "phone", "resident_B"]);
  assert.equal(cf.inserted.effective, true);
});

test("the same rub under C. difficile changes nothing", () => {
  const { input, base } = baseFor("c_difficile");
  const cf = runCounterfactual(input, base, { handId: "bare_hand", t: 3, agent: "alcohol_rub" }, SCORE_WEIGHTS);
  assert.equal(cf.inserted.effective, false);
  assert.deepEqual(cf.after, cf.before);
  assert.deepEqual(cf.keptClean, []);
});

test("soap and water under C. difficile does work", () => {
  const { input, base } = baseFor("c_difficile");
  const cf = runCounterfactual(input, base, { handId: "bare_hand", t: 3, agent: "soap_water" }, SCORE_WEIGHTS);
  assert.equal(cf.after.contaminatedSurfaces, 0);
});

test("hygiene inserted after the last contact only cleans the hands; surfaces and exposures stand", () => {
  const { input, base } = baseFor("mrsa");
  const cf = runCounterfactual(input, base, { handId: "bare_hand", t: 20, agent: "soap_water" }, SCORE_WEIGHTS);
  assert.deepEqual([...cf.keptClean].sort(), ["bare_hand", "gloved_hand"]);
  assert.equal(cf.after.contaminatedSurfaces, cf.before.contaminatedSurfaces);
  assert.deepEqual(cf.after.residentExposures, cf.before.residentExposures);
  assert.equal(cf.after.score, cf.before.score);
});

test("rejects a negative time and is deterministic", () => {
  const { input, base } = baseFor("mrsa");
  assert.throws(() => runCounterfactual(input, base, { handId: "bare_hand", t: -1, agent: "soap_water" }, SCORE_WEIGHTS));
  const a = runCounterfactual(input, base, { handId: "bare_hand", t: 10, agent: "soap_water" }, SCORE_WEIGHTS);
  const b = runCounterfactual(input, base, { handId: "bare_hand", t: 10, agent: "soap_water" }, SCORE_WEIGHTS);
  assert.deepEqual(a, b);
});
