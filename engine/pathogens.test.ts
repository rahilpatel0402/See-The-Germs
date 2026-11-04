import { test } from "node:test";
import assert from "node:assert/strict";
import { agentClearsHands, isPathogenId, PATHOGEN_IDS, PATHOGENS } from "./pathogens.ts";

test("the table holds exactly the four PLAN.md pathogens", () => {
  assert.deepEqual([...PATHOGEN_IDS].sort(), ["c_auris", "c_difficile", "mrsa", "norovirus"]);
  for (const id of PATHOGEN_IDS) assert.equal(PATHOGENS[id].id, id);
});

test("alcohol rub clears MRSA and C. auris but not C. difficile or norovirus", () => {
  assert.equal(agentClearsHands(PATHOGENS.mrsa, "alcohol_rub"), true);
  assert.equal(agentClearsHands(PATHOGENS.c_auris, "alcohol_rub"), true);
  assert.equal(agentClearsHands(PATHOGENS.c_difficile, "alcohol_rub"), false);
  assert.equal(agentClearsHands(PATHOGENS.norovirus, "alcohol_rub"), false);
});

test("soap and water clears hands for all four", () => {
  for (const id of PATHOGEN_IDS) assert.equal(agentClearsHands(PATHOGENS[id], "soap_water"), true);
});

test("surfaces persist for longer than any clip", () => {
  for (const id of PATHOGEN_IDS) assert.ok(PATHOGENS[id].surfacePersistenceS > 24 * 3600);
});

test("isPathogenId guards unknown ids", () => {
  assert.equal(isPathogenId("mrsa"), true);
  assert.equal(isPathogenId("ebola"), false);
});

test("every pathogen rule carries at least one CDC, WHO, or EPA citation over https", () => {
  for (const p of Object.values(PATHOGENS)) {
    assert.ok(p.citations.length >= 1, `${p.id} has no citation`);
    for (const url of p.citations) {
      assert.match(url, /^https:\/\/(www\.)?(cdc\.gov|who\.int|epa\.gov)\//, `${p.id}: ${url} is not a CDC, WHO, or EPA page`);
    }
  }
  // The rules that alcohol does not clear C. difficile spores or norovirus cite a CDC page about that pathogen.
  assert.ok(PATHOGENS.c_difficile.citations.some((u) => u.includes("c-diff")));
  assert.ok(PATHOGENS.norovirus.citations.some((u) => u.includes("norovirus")));
});
