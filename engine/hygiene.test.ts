import { test } from "node:test";
import assert from "node:assert/strict";
import { HYGIENE_CONFIG } from "./config.ts";
import { CLIP_A_ENTITIES, contact } from "./fixtures.ts";
import { splitHygiene } from "./hygiene.ts";
import { PATHOGENS } from "./pathogens.ts";

test("a dispenser dwell of at least one second becomes a hygiene event, shorter is nothing", () => {
  const contacts = [contact("bare_hand", "sanitizer", 3.0, 4.2), contact("bare_hand", "sanitizer", 9.0, 9.5)];
  const split = splitHygiene(contacts, CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG);
  assert.equal(split.hygieneEvents.length, 1);
  assert.deepEqual(split.hygieneEvents[0], { handId: "bare_hand", t: 3.0, agent: "alcohol_rub", effective: true });
  assert.deepEqual(split.contacts, []);
});

test("effectiveness follows the pathogen", () => {
  const contacts = [contact("bare_hand", "sanitizer", 3.0, 4.5), contact("bare_hand", "sink", 6.0, 8.0)];
  const cdiff = splitHygiene(contacts, CLIP_A_ENTITIES, PATHOGENS.c_difficile, HYGIENE_CONFIG);
  assert.deepEqual(cdiff.hygieneEvents.map((h) => [h.agent, h.effective]), [["alcohol_rub", false], ["soap_water", true]]);
  const mrsa = splitHygiene(contacts, CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG);
  assert.deepEqual(mrsa.hygieneEvents.map((h) => h.effective), [true, true]);
});

test("glove box dwell is a glove box touch, not hygiene, and other contacts pass through", () => {
  const contacts = [contact("bare_hand", "rail_A", 1.0, 2.0), contact("bare_hand", "glove_box", 2.5, 4.0), contact("gloved_hand", "phone", 5.0, 6.0)];
  const split = splitHygiene(contacts, CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG);
  assert.deepEqual(split.gloveBoxTouches, [{ handId: "bare_hand", t: 2.5 }]);
  assert.deepEqual(split.hygieneEvents, []);
  assert.deepEqual(split.contacts.map((c) => c.entityId), ["rail_A", "phone"]);
});

test("a dispenser without an agent is an error, an unknown entity is an error", () => {
  const entities = [...CLIP_A_ENTITIES, { id: "mystery", label: "mystery", class: "dispenser" as const, zone: "hygiene_station" as const, samPhrase: "box" }];
  assert.throws(() => splitHygiene([contact("bare_hand", "mystery", 0, 2)], entities, PATHOGENS.mrsa, HYGIENE_CONFIG));
  assert.throws(() => splitHygiene([contact("bare_hand", "nope", 0, 2)], CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG));
});
