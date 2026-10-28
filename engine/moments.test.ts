import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIP_A_CONTACTS, CLIP_A_ENTITIES, contact } from "./fixtures.ts";
import { detectMomentMisses, detectMomentOpportunities } from "./moments.ts";
import { PATHOGENS } from "./pathogens.ts";
import { propagate, type PropagationInput } from "./propagation.ts";
import type { ContactEvent, HygieneEvent } from "./types.ts";

function run(contacts: readonly ContactEvent[], hygieneEvents: readonly HygieneEvent[] = []) {
  const input: PropagationInput = {
    contacts,
    hygieneEvents,
    gloveEvents: [],
    entities: CLIP_A_ENTITIES,
    scenario: { sourceEntityId: "rail_A", pathogen: "mrsa" },
    profile: PATHOGENS.mrsa,
  };
  const base = propagate(input);
  return detectMomentMisses({ contacts, hygieneEvents, entities: CLIP_A_ENTITIES }, base, (inserted) =>
    propagate({ ...input, hygieneEvents: [...hygieneEvents, inserted] }),
  );
}

const rub = (t: number): HygieneEvent => ({ handId: "bare_hand", t, agent: "alcohol_rub", durationS: 25, adequate: true, effective: true });

test("clip A misses Moment 5 leaving rail A and Moment 1 before resident B, with downstream impact", () => {
  const misses = run(CLIP_A_CONTACTS);
  assert.deepEqual(misses.map((m) => [m.moment, m.t]), [[5, 2], [1, 15]]);
  assert.deepEqual([...misses[0]!.downstream].sort(), ["bare_hand", "blanket_B", "gloved_hand", "iv_pole", "phone", "resident_B"]);
  assert.deepEqual([...misses[1]!.downstream].sort(), ["bare_hand", "gloved_hand", "resident_B"]);
});

test("effective hygiene after the rail clears Moment 5, but resident B still needs Moment 1 after the phone", () => {
  const misses = run(CLIP_A_CONTACTS, [rub(3)]);
  assert.deepEqual(misses.map((m) => [m.moment, m.t]), [[1, 15]]);
  // The hand was already clean, so inserting hygiene there changes nothing downstream.
  assert.deepEqual(misses[0]!.downstream, []);
});

test("hygiene after the rail and again before resident B clears every miss", () => {
  assert.deepEqual(run(CLIP_A_CONTACTS, [rub(3), rub(14)]), []);
});

test("ineffective hygiene does not count", () => {
  const misses = run(CLIP_A_CONTACTS, [{ handId: "bare_hand", t: 3, agent: "alcohol_rub", durationS: 5, adequate: false, effective: false }]);
  assert.deepEqual(misses.map((m) => m.moment), [5, 1]);
});

test("opportunities count met moments too, once per lapse", () => {
  const input = { contacts: CLIP_A_CONTACTS, hygieneEvents: [rub(3), rub(14)], entities: CLIP_A_ENTITIES };
  const opportunities = detectMomentOpportunities(input);
  assert.deepEqual(opportunities.map((o) => [o.moment, o.t, o.met]), [[5, 2, true], [1, 15, true]]);
  // Touching resident B twice after one washed arrival is still one met opportunity.
  const twice = { ...input, contacts: [...CLIP_A_CONTACTS, contact("bare_hand", "resident_B", 17, 18)] };
  assert.equal(detectMomentOpportunities(twice).filter((o) => o.moment === 1).length, 1);
});

test("Moment 4: after touching a resident, the next healthcare area contact without hygiene", () => {
  const contacts = [contact("bare_hand", "resident_B", 1, 2), contact("bare_hand", "phone", 4, 5)];
  assert.deepEqual(run(contacts).map((m) => [m.moment, m.t]), [[4, 2]]);
  assert.deepEqual(run(contacts, [rub(3)]), []);
});

test("Moment 2: an aseptic task without hygiene immediately before it", () => {
  const contacts = [contact("bare_hand", "phone", 1, 2), contact("bare_hand", "glucometer", 4, 5)];
  assert.deepEqual(run(contacts).map((m) => m.moment), [2]);
  assert.deepEqual(run(contacts, [rub(3)]), []);
});

test("an aseptic task the detector split into pieces is one Moment 2 miss", () => {
  const contacts = [contact("bare_hand", "phone", 1, 2), contact("bare_hand", "glucometer", 4.0, 4.6), contact("bare_hand", "glucometer", 4.9, 5.5), contact("bare_hand", "glucometer", 5.8, 6.4)];
  assert.deepEqual(run(contacts).map((m) => [m.moment, m.t]), [[2, 4]]);
});

test("leaving a patient zone after touching the resident is Moment 4 even via a same-zone object", () => {
  // resident B, then blanket B, then the phone: one departure, the resident was touched, so Moment 4 at the blanket's end.
  const contacts = [contact("bare_hand", "resident_B", 5, 6), contact("bare_hand", "blanket_B", 7, 8), contact("bare_hand", "phone", 10, 11)];
  assert.deepEqual(run(contacts).map((m) => [m.moment, m.t]), [[4, 8]]);
  // Without the resident it is Moment 5.
  const surroundingsOnly = [contact("bare_hand", "blanket_B", 7, 8), contact("bare_hand", "phone", 10, 11)];
  assert.deepEqual(run(surroundingsOnly).map((m) => [m.moment, m.t]), [[5, 8]]);
});

test("Moment 1 looks back past same-zone contacts to the last contact outside the zone", () => {
  // phone (healthcare) -> blanket B -> resident B: the blanket is inside zone B, so the miss is
  // still scored against the phone, and only once.
  const contacts = [contact("bare_hand", "phone", 1, 2), contact("bare_hand", "blanket_B", 4, 5), contact("bare_hand", "resident_B", 7, 8)];
  assert.deepEqual(run(contacts).map((m) => [m.moment, m.t]), [[1, 7]]);
});

test("Moment 5 also fires when leaving patient zone A objects for patient zone B", () => {
  const contacts = [contact("bare_hand", "rail_A", 1, 2), contact("bare_hand", "blanket_B", 4, 5)];
  assert.deepEqual(run(contacts).map((m) => [m.moment, m.t]), [[5, 2]]);
  // Then touching resident B adds Moment 1 at the resident contact, scored against the rail.
  const withResident = [...contacts, contact("bare_hand", "resident_B", 7, 8)];
  assert.deepEqual(run(withResident).map((m) => [m.moment, m.t]), [[5, 2], [1, 7]]);
});

test("touching the same resident twice after one unwashed arrival is one Moment 1 miss, not two", () => {
  const contacts = [contact("bare_hand", "phone", 1, 2), contact("bare_hand", "resident_B", 5, 6), contact("bare_hand", "resident_B", 8, 9)];
  assert.deepEqual(run(contacts).map((m) => [m.moment, m.t]), [[1, 5]]);
  // Leaving the zone and coming back without hygiene is a new lapse.
  const again = [...contacts, contact("bare_hand", "phone", 11, 12), contact("bare_hand", "resident_B", 14, 15)];
  assert.deepEqual(run(again).map((m) => [m.moment, m.t]), [[1, 5], [4, 9], [1, 14]]);
});

test("a zone episode ends when its longest contact ends", () => {
  // Rail held 2 to 9 s while the blanket is brushed at 3 to 3.5 s; the departure is at 9 s, not 3.5 s.
  const contacts = [contact("bare_hand", "rail_A", 2, 9), contact("bare_hand", "blanket_B", 3, 3.5), contact("bare_hand", "phone", 10, 11)];
  const entities = CLIP_A_ENTITIES.map((e) => (e.id === "blanket_B" ? { ...e, zone: "patient_zone_A" as const } : e));
  const input: PropagationInput = { contacts, hygieneEvents: [], gloveEvents: [], entities, scenario: { sourceEntityId: "rail_A", pathogen: "mrsa" }, profile: PATHOGENS.mrsa };
  const misses = detectMomentMisses({ contacts, hygieneEvents: [], entities }, propagate(input), (ins) => propagate({ ...input, hygieneEvents: [ins] }));
  assert.deepEqual(misses.map((m) => [m.moment, m.t]), [[5, 9]]);
});

test("moving inside one patient zone is not a miss, and a first contact is never a miss", () => {
  assert.deepEqual(run([contact("bare_hand", "rail_A", 1, 2)]), []);
  assert.deepEqual(run([contact("bare_hand", "blanket_B", 1, 2), contact("bare_hand", "resident_B", 3, 4)]), []);
});

test("a second person is scored independently", () => {
  const entities = [
    ...CLIP_A_ENTITIES,
    { id: "p2_bare", label: "P2 bare", class: "bare_hand" as const, zone: "healthcare_area" as const, samPhrase: "bare hand", person: "P2" },
  ];
  const contacts = [contact("bare_hand", "rail_A", 1, 2), contact("p2_bare", "phone", 3, 4)];
  const input: PropagationInput = { contacts, hygieneEvents: [], gloveEvents: [], entities, scenario: { sourceEntityId: "rail_A", pathogen: "mrsa" }, profile: PATHOGENS.mrsa };
  const misses = detectMomentMisses({ contacts, hygieneEvents: [], entities }, propagate(input), (ins) => propagate({ ...input, hygieneEvents: [ins] }));
  assert.deepEqual(misses, []);
});
