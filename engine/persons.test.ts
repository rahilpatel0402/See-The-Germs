import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSON_CONFIG } from "./config.ts";
import { assignHandObjects, labelPersons, RESIDENT_PERSON, splitHandsByPerson } from "./persons.ts";
import type { Entity, MaskRecord } from "./types.ts";

const rec = (frameIndex: number, objectId: string, left: number, top: number, w: number, h: number): MaskRecord => ({
  frameIndex,
  objectId,
  bounds: { left, top, right: left + w, bottom: top + h },
  mask: { encoding: "one_bit", width: w, height: h, payload: "x" },
});

// Two people standing, 0 to 9 frames: person a on the left, person b on the right.
function twoPeople(): MaskRecord[] {
  const out: MaskRecord[] = [];
  for (let f = 0; f < 10; f++) out.push(rec(f, "a", 0, 0, 40, 100), rec(f, "b", 60, 0, 40, 100));
  return out;
}

test("people are named in order of first appearance, leftmost first", () => {
  const labels = labelPersons(twoPeople(), [], PERSON_CONFIG);
  assert.deepEqual([...labels.entries()], [["a", "P1"], ["b", "P2"]]);
  // A person who arrives later is P2 even if standing further left.
  const late = [...twoPeople().filter((r) => r.objectId === "b"), ...Array.from({ length: 5 }, (_, i) => rec(5 + i, "c", 0, 0, 40, 100))];
  assert.deepEqual([...labelPersons(late, [], PERSON_CONFIG).entries()], [["b", "P1"], ["c", "P2"]]);
});

test("a person lying on the resident zone is the resident, not a caregiver", () => {
  // Person a stands on the left; person b lies across the bed on the right under a sheet that
  // covers most of their box. A standing person under the same sheet would still be a caregiver.
  const persons: MaskRecord[] = [];
  for (let f = 0; f < 10; f++) persons.push(rec(f, "a", 0, 0, 40, 100), rec(f, "b", 50, 60, 100, 30));
  const sheet = Array.from({ length: 10 }, (_, f) => rec(f, "s", 35, 50, 130, 50));
  const labels = labelPersons(persons, sheet, PERSON_CONFIG);
  assert.equal(labels.get("a"), "P1");
  assert.equal(labels.get("b"), RESIDENT_PERSON);
  const standing: MaskRecord[] = [];
  for (let f = 0; f < 10; f++) standing.push(rec(f, "a", 0, 0, 40, 100), rec(f, "c", 50, 0, 40, 100));
  const tallSheet = Array.from({ length: 10 }, (_, f) => rec(f, "s", 45, 0, 60, 100));
  assert.equal(labelPersons(standing, tallSheet, PERSON_CONFIG).get("c"), "P2");
});

test("hand objects go to the person whose box holds them, by majority over frames", () => {
  const persons = twoPeople();
  const labels = labelPersons(persons, [], PERSON_CONFIG);
  const hands: MaskRecord[] = [];
  for (let f = 0; f < 10; f++) {
    hands.push(rec(f, "h1", 10, 50, 10, 10)); // inside a
    hands.push(rec(f, "h2", 70, 50, 10, 10)); // inside b
    hands.push(rec(f, "h3", f < 3 ? 10 : 70, 50, 10, 10)); // mostly inside b
    hands.push(rec(f, "h4", 55, 150, 10, 10)); // inside nobody, nearer to b
  }
  const assigned = assignHandObjects(hands, persons, labels);
  assert.deepEqual([...assigned.entries()], [["h1", "P1"], ["h2", "P2"], ["h3", "P2"], ["h4", "P2"]]);
  // A hand seen only in frames with nobody present stays with the default caregiver.
  const alone = [rec(20, "h5", 0, 0, 5, 5), rec(21, "h5", 0, 0, 5, 5)];
  assert.equal(assignHandObjects(alone, persons, labels).get("h5"), "P1");
});

test("when two person boxes overlap, the tighter box around the hand wins", () => {
  const persons: MaskRecord[] = [];
  for (let f = 0; f < 4; f++) persons.push(rec(f, "big", 0, 0, 100, 100), rec(f, "small", 40, 40, 20, 20));
  const labels = labelPersons(persons, [], PERSON_CONFIG);
  const hands = Array.from({ length: 4 }, (_, f) => rec(f, "h", 45, 45, 5, 5));
  assert.equal(assignHandObjects(hands, persons, labels).get("h"), labels.get("small"));
});

test("hands split per caregiver: the base keeps the entity, the second gets a copy, the resident's are dropped", () => {
  const bare: Entity = { id: "bare_hand", label: "bare hand", class: "bare_hand", zone: "healthcare_area", samPhrase: "bare hand", person: "P1" };
  const rail: Entity = { id: "rail", label: "rail", class: "object", zone: "patient_zone_A", samPhrase: "white rod" };
  const records = new Map<string, MaskRecord[]>([
    ["bare_hand", [rec(0, "x", 0, 0, 5, 5), rec(0, "y", 50, 0, 5, 5), rec(0, "z", 90, 0, 5, 5)]],
    ["rail", [rec(0, "r", 0, 50, 100, 5)]],
  ]);
  const owner = new Map([["bare_hand|x", "P1"], ["bare_hand|y", "P2"], ["bare_hand|z", RESIDENT_PERSON]]);
  const out = splitHandsByPerson([bare, rail], records, owner);
  assert.deepEqual(out.map((t) => [t.entity.id, t.entity.label, t.entity.person ?? "", t.records.map((r) => r.objectId)]), [
    ["bare_hand", "bare hand (caregiver 1)", "P1", ["x"]],
    ["bare_hand_p2", "bare hand (caregiver 2)", "P2", ["y"]],
    ["rail", "rail", "", ["r"]],
  ]);
  // One caregiver only: labels stay plain and an entity with no records survives, empty.
  const one = splitHandsByPerson([bare], new Map([["bare_hand", [rec(0, "z", 90, 0, 5, 5)]]]), new Map([["bare_hand|z", RESIDENT_PERSON]]));
  assert.deepEqual(one.map((t) => [t.entity.id, t.entity.label, t.records.length]), [["bare_hand", "bare hand", 0]]);
  // A free-form person name becomes a safe id.
  const named = splitHandsByPerson([bare], new Map([["bare_hand", [rec(0, "q", 0, 0, 5, 5)]]]), new Map([["bare_hand|q", "Nurse A"]]));
  assert.deepEqual(named.map((t) => [t.entity.id, t.entity.label]), [["bare_hand", "bare hand (caregiver 1)"], ["bare_hand_nurse_a", "bare hand (Nurse A)"]]);
});
