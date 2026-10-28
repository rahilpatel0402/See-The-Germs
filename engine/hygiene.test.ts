import { test } from "node:test";
import assert from "node:assert/strict";
import { HYGIENE_CONFIG } from "./config.ts";
import { CLIP_A_ENTITIES, contact } from "./fixtures.ts";
import { splitHygiene } from "./hygiene.ts";
import { PATHOGENS } from "./pathogens.ts";

test("a dispenser dwell of at least one second becomes a hygiene event, shorter is nothing", () => {
  const contacts = [contact("bare_hand", "sanitizer", 3.0, 4.2), contact("bare_hand", "sanitizer", 9.0, 9.5)];
  const split = splitHygiene(contacts, CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG, 60);
  assert.equal(split.hygieneEvents.length, 1);
  assert.equal(split.hygieneEvents[0]!.t, 3.0);
  assert.deepEqual(split.contacts, []);
});

test("rub time runs from the dispenser to the next touch; 20 s of alcohol rub is adequate, 8 s is not", () => {
  const adequate = splitHygiene([contact("bare_hand", "sanitizer", 3.0, 4.5), contact("bare_hand", "phone", 24.0, 25.0)], CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG, 60);
  assert.equal(adequate.hygieneEvents[0]!.durationS, 21);
  assert.equal(adequate.hygieneEvents[0]!.adequate, true);
  assert.equal(adequate.hygieneEvents[0]!.effective, true);

  const short = splitHygiene([contact("bare_hand", "sanitizer", 3.0, 4.5), contact("bare_hand", "phone", 11.0, 12.0)], CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG, 60);
  assert.equal(short.hygieneEvents[0]!.durationS, 8);
  assert.equal(short.hygieneEvents[0]!.adequate, false);
  assert.equal(short.hygieneEvents[0]!.effective, false);
  // With the duration rule relaxed, the same short rub is effective under MRSA.
  const relaxed = splitHygiene([contact("bare_hand", "sanitizer", 3.0, 4.5), contact("bare_hand", "phone", 11.0, 12.0)], CLIP_A_ENTITIES, PATHOGENS.mrsa, { ...HYGIENE_CONFIG, inadequateIsIneffective: false }, 60);
  assert.equal(relaxed.hygieneEvents[0]!.effective, true);
});

test("soap and water needs 40 s, and the clip end bounds the rub when nothing follows", () => {
  const sink = splitHygiene([contact("bare_hand", "sink", 5.0, 7.0)], CLIP_A_ENTITIES, PATHOGENS.c_difficile, HYGIENE_CONFIG, 50);
  assert.equal(sink.hygieneEvents[0]!.durationS, 45);
  assert.equal(sink.hygieneEvents[0]!.adequate, true);
  const cut = splitHygiene([contact("bare_hand", "sink", 5.0, 7.0)], CLIP_A_ENTITIES, PATHOGENS.c_difficile, HYGIENE_CONFIG, 30);
  assert.equal(cut.hygieneEvents[0]!.adequate, false);
});

test("effectiveness follows the pathogen even when the rub is long enough", () => {
  const contacts = [contact("bare_hand", "sanitizer", 3.0, 4.5), contact("bare_hand", "sink", 30.0, 32.0), contact("bare_hand", "phone", 80, 81)];
  const cdiff = splitHygiene(contacts, CLIP_A_ENTITIES, PATHOGENS.c_difficile, HYGIENE_CONFIG, 90);
  assert.deepEqual(cdiff.hygieneEvents.map((h) => [h.agent, h.adequate, h.effective]), [["alcohol_rub", true, false], ["soap_water", true, true]]);
});

test("the next touch is the same person's, so another person's contact does not cut the rub short", () => {
  const entities = [...CLIP_A_ENTITIES, { id: "p2", label: "P2", class: "bare_hand" as const, zone: "healthcare_area" as const, samPhrase: "bare hand", person: "P2" }];
  const contacts = [contact("bare_hand", "sanitizer", 3.0, 4.5), contact("p2", "phone", 6.0, 7.0), contact("bare_hand", "phone", 30.0, 31.0)];
  const split = splitHygiene(contacts, entities, PATHOGENS.mrsa, HYGIENE_CONFIG, 60);
  assert.equal(split.hygieneEvents[0]!.durationS, 27);
});

test("glove box dwell is a glove box touch, not hygiene, and other contacts pass through", () => {
  const contacts = [contact("bare_hand", "rail_A", 1.0, 2.0), contact("bare_hand", "glove_box", 2.5, 4.0), contact("gloved_hand", "phone", 5.0, 6.0)];
  const split = splitHygiene(contacts, CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG, 60);
  assert.deepEqual(split.gloveBoxTouches, [{ handId: "bare_hand", t: 2.5 }]);
  assert.deepEqual(split.hygieneEvents, []);
  assert.deepEqual(split.contacts.map((c) => c.entityId), ["rail_A", "phone"]);
});

test("a dispenser without an agent is an error, an unknown entity is an error", () => {
  const entities = [...CLIP_A_ENTITIES, { id: "mystery", label: "mystery", class: "dispenser" as const, zone: "hygiene_station" as const, samPhrase: "box" }];
  assert.throws(() => splitHygiene([contact("bare_hand", "mystery", 0, 2)], entities, PATHOGENS.mrsa, HYGIENE_CONFIG, 60));
  assert.throws(() => splitHygiene([contact("bare_hand", "nope", 0, 2)], CLIP_A_ENTITIES, PATHOGENS.mrsa, HYGIENE_CONFIG, 60));
});
