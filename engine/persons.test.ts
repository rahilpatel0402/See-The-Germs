import { test } from "node:test";
import assert from "node:assert/strict";
import { assignHandObjects, labelPersons, PERSON_CONFIG, RESIDENT_PERSON } from "./persons.ts";
import type { MaskRecord } from "./types.ts";

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
    hands.push(rec(f, "h4", 45, 150, 10, 10)); // inside nobody
  }
  const assigned = assignHandObjects(hands, persons, labels);
  assert.deepEqual([...assigned.entries()], [["h1", "P1"], ["h2", "P2"], ["h3", "P2"], ["h4", "P1"]]);
});

test("when two person boxes overlap, the tighter box around the hand wins", () => {
  const persons: MaskRecord[] = [];
  for (let f = 0; f < 4; f++) persons.push(rec(f, "big", 0, 0, 100, 100), rec(f, "small", 40, 40, 20, 20));
  const labels = labelPersons(persons, [], PERSON_CONFIG);
  const hands = Array.from({ length: 4 }, (_, f) => rec(f, "h", 45, 45, 5, 5));
  assert.equal(assignHandObjects(hands, persons, labels).get("h"), labels.get("small"));
});
