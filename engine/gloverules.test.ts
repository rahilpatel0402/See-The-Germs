import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIP_A_ENTITIES, contact } from "./fixtures.ts";
import { detectGloveIssues } from "./gloverules.ts";
import type { GloveEvent, HygieneEvent } from "./types.ts";

const don = (t: number): GloveEvent => ({ handId: "bare_hand", t, type: "don", source: "detected" });
const doff = (t: number): GloveEvent => ({ handId: "bare_hand", t, type: "doff", source: "detected" });
const rub = (t: number): HygieneEvent => ({ handId: "bare_hand", t, agent: "alcohol_rub", durationS: 25, adequate: true, effective: true });

function run(contacts: Parameters<typeof detectGloveIssues>[0]["contacts"], gloveEvents: GloveEvent[], hygieneEvents: HygieneEvent[] = []) {
  return detectGloveIssues({ contacts, gloveEvents, hygieneEvents, entities: CLIP_A_ENTITIES, clipDurationS: 60 });
}

test("the clean run: hygiene before don and after doff, one resident, no issues", () => {
  const contacts = [contact("bare_hand", "rail_A", 1, 2), contact("gloved_hand", "blanket_B", 30, 31), contact("gloved_hand", "resident_B", 32, 33), contact("bare_hand", "phone", 58, 59)];
  assert.deepEqual(run(contacts, [don(27), doff(35)], [rub(3), rub(36)]), []);
});

test("gloving straight after touching the rail is a missed hygiene before donning", () => {
  const contacts = [contact("bare_hand", "rail_A", 1, 2), contact("gloved_hand", "resident_B", 10, 11)];
  const issues = run(contacts, [don(5)]);
  assert.deepEqual(issues.map((i) => [i.type, i.t, i.entityIds]), [["no_hygiene_before_don", 5, ["rail_A"]]]);
});

test("touching the phone after doffing without hygiene is flagged", () => {
  const contacts = [contact("gloved_hand", "resident_B", 10, 11), contact("bare_hand", "phone", 20, 21)];
  const issues = run(contacts, [don(5), doff(15)]);
  assert.deepEqual(issues.map((i) => [i.type, i.t, i.entityIds]), [["no_hygiene_after_doff", 15, ["phone"]]]);
  assert.deepEqual(run(contacts, [don(5), doff(15)], [rub(16)]), []);
});

test("one pair of gloves across two residents, and a gloved hand on the phone", () => {
  const entities = [...CLIP_A_ENTITIES, { id: "resident_A", label: "resident A", class: "resident_zone" as const, zone: "patient_zone_A" as const, samPhrase: "pillow" }];
  const contacts = [contact("gloved_hand", "resident_A", 10, 11), contact("gloved_hand", "phone", 13, 14), contact("gloved_hand", "resident_B", 16, 17)];
  const issues = detectGloveIssues({ contacts, gloveEvents: [don(5)], hygieneEvents: [rub(3)], entities, clipDurationS: 60 });
  assert.deepEqual(issues.map((i) => [i.type, i.t]), [["gloved_healthcare_area_contact", 13], ["glove_across_residents", 16]]);
  assert.deepEqual(issues[1]!.entityIds, ["resident_A", "resident_B"]);
});

test("a don with no contact before it and a doff with no contact after it raise nothing", () => {
  const contacts = [contact("gloved_hand", "resident_B", 10, 11)];
  assert.deepEqual(run(contacts, [don(5), doff(15)]), []);
});

test("a second don for the same person while gloved is ignored", () => {
  const contacts = [contact("bare_hand", "rail_A", 1, 2), contact("gloved_hand", "resident_B", 10, 11)];
  const issues = run(contacts, [don(5), don(7)]);
  assert.equal(issues.length, 1);
});

test("the contact before donning is the one that ended last, not the one that started last", () => {
  // Rail held 1 to 9 s, phone brushed 2 to 3 s, rub at 5 s, gloves on at 10 s: the hand touched
  // the rail after the rub, so the don is not covered.
  const contacts = [contact("bare_hand", "rail_A", 1, 9), contact("bare_hand", "phone", 2, 3), contact("gloved_hand", "resident_B", 12, 13)];
  const issues = run(contacts, [don(10)], [rub(5)]);
  assert.deepEqual(issues.map((i) => [i.type, i.t, i.entityIds]), [["no_hygiene_before_don", 10, ["rail_A"]]]);
});
