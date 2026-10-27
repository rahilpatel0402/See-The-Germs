import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIP_A_CONTACTS, CLIP_A_ENTITIES, contact } from "./fixtures.ts";
import { PATHOGENS } from "./pathogens.ts";
import { propagate, type PropagationInput } from "./propagation.ts";
import type { GloveEvent, HygieneEvent } from "./types.ts";

const base: PropagationInput = {
  contacts: CLIP_A_CONTACTS,
  hygieneEvents: [],
  gloveEvents: [],
  entities: CLIP_A_ENTITIES,
  scenario: { sourceEntityId: "rail_A", pathogen: "mrsa" },
  profile: PATHOGENS.mrsa,
};

const rub = (t: number, effective: boolean): HygieneEvent => ({ handId: "bare_hand", t, agent: "alcohol_rub", effective });
const glove = (t: number, type: "don" | "doff"): GloveEvent => ({ handId: "bare_hand", t, type, source: "detected" });

test("clip A: the chain runs rail -> hand -> IV pole -> phone -> blanket B -> resident B", () => {
  const r = propagate(base);
  assert.deepEqual(r.transfers.map((e) => `${e.fromId}->${e.toId}@${e.t}`), [
    "rail_A->bare_hand@1",
    "bare_hand->iv_pole@4",
    "bare_hand->phone@7",
    "bare_hand->blanket_B@12",
    "bare_hand->resident_B@15",
  ]);
  assert.deepEqual([...r.contaminated].sort(), ["bare_hand", "blanket_B", "gloved_hand", "iv_pole", "phone", "rail_A", "resident_B"]);
  assert.deepEqual(r.residentExposures, [{ residentId: "resident_B", handId: "bare_hand", t: 15 }]);
  // Graph hops: the hand is one node, so everything it touched is two hops from the rail.
  assert.equal(r.hops["person:P1"], 1);
  assert.equal(r.hops["iv_pole"], 2);
  assert.equal(r.hops["resident_B"], 2);
  assert.equal(r.changes[0]?.cause, "source");
  assert.equal(r.hands["P1"]?.contaminated, true);
});

test("an alcohol rub at t=3 breaks the chain under MRSA", () => {
  const r = propagate({ ...base, hygieneEvents: [rub(3, true)] });
  assert.deepEqual([...r.contaminated].sort(), ["rail_A"]);
  assert.deepEqual(r.residentExposures, []);
  assert.deepEqual(r.transfers.map((e) => e.toId), ["bare_hand"]);
  assert.ok(r.changes.some((c) => c.cause === "hygiene" && c.entityId === "bare_hand" && c.t === 3));
});

test("the same rub under C. difficile is ineffective and the chain continues", () => {
  const r = propagate({ ...base, profile: PATHOGENS.c_difficile, scenario: { sourceEntityId: "rail_A", pathogen: "c_difficile" }, hygieneEvents: [rub(3, false)] });
  assert.equal(r.contaminated.includes("resident_B"), true);
  assert.equal(r.residentExposures.length, 1);
  assert.equal(r.changes.some((c) => c.cause === "hygiene"), false);
});

test("a glove don gives a clean surface; the doff exposes the bare hand again", () => {
  // Don at 3 after touching the rail: IV pole and phone stay clean. Doff at 9: the pre-glove
  // contamination returns, so blanket B and resident B are contaminated.
  const r = propagate({ ...base, gloveEvents: [glove(3, "don"), glove(9, "doff")] });
  assert.deepEqual([...r.contaminated].sort(), ["bare_hand", "blanket_B", "gloved_hand", "rail_A", "resident_B"]);
  assert.equal(r.hands["P1"]?.gloved, false);
  assert.ok(r.changes.some((c) => c.cause === "glove_don" && c.contaminated === false));
  assert.ok(r.changes.some((c) => c.cause === "glove_doff" && c.contaminated === true));
});

test("a glove that touched a contaminated surface contaminates the bare hand on doff", () => {
  // Clean hand dons at 0.5, touches the rail (source) gloved, doffs at 3, then touches the phone.
  const r = propagate({
    ...base,
    contacts: [contact("gloved_hand", "rail_A", 1, 2), contact("bare_hand", "phone", 5, 6)],
    gloveEvents: [glove(0.5, "don"), glove(3, "doff")],
  });
  assert.equal(r.contaminated.includes("phone"), true);
});

test("a contaminated hand touching a resident logs an exposure even when the resident is already contaminated", () => {
  const r = propagate({ ...base, contacts: [...CLIP_A_CONTACTS, contact("bare_hand", "resident_B", 18, 19)] });
  assert.equal(r.residentExposures.length, 2);
  assert.equal(r.transfers.filter((e) => e.toId === "resident_B").length, 1);
});

test("a hand can be the source", () => {
  const r = propagate({ ...base, scenario: { sourceEntityId: "bare_hand", pathogen: "mrsa" } });
  assert.equal(r.hops["person:P1"], 0);
  assert.equal(r.hops["rail_A"], 1);
});

test("events at the same time apply glove, then hygiene, then contact", () => {
  const r = propagate({ ...base, hygieneEvents: [rub(4, true)] });
  // Rub at exactly 4 happens before the IV pole contact at 4, so the pole stays clean.
  assert.equal(r.contaminated.includes("iv_pole"), false);
});

test("dispenser contacts and unknown entities are errors", () => {
  assert.throws(() => propagate({ ...base, contacts: [contact("bare_hand", "sanitizer", 1, 2)] }));
  assert.throws(() => propagate({ ...base, contacts: [contact("bare_hand", "nope", 1, 2)] }));
  assert.throws(() => propagate({ ...base, contacts: [contact("phone", "rail_A", 1, 2)] }));
});

test("same input, same output", () => {
  assert.deepEqual(propagate(base), propagate(base));
});
