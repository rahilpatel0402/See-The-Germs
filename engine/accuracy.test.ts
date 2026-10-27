import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreContacts } from "./accuracy.ts";

const L = (handId: string, entityId: string, startT: number, endT = startT + 1) => ({ handId, entityId, startT, endT });

test("exact agreement scores 1 and 1", () => {
  const labels = [L("h", "rail", 1.0), L("h", "phone", 5.0)];
  const r = scoreContacts(labels, labels, 1.0);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.misses, []);
  assert.deepEqual(r.falseAlarms, []);
});

test("a start within tolerance matches, outside it is a miss plus a false alarm", () => {
  const near = scoreContacts([L("h", "rail", 1.0)], [L("h", "rail", 1.9)], 1.0);
  assert.equal(near.matched, 1);
  assert.equal(near.matches[0]!.startErrorS.toFixed(1), "0.9");
  const far = scoreContacts([L("h", "rail", 1.0)], [L("h", "rail", 2.2)], 1.0);
  assert.equal(far.matched, 0);
  assert.equal(far.misses.length, 1);
  assert.equal(far.falseAlarms.length, 1);
  assert.equal(far.precision, 0);
  assert.equal(far.recall, 0);
});

test("hand and entity must both agree", () => {
  const r = scoreContacts([L("bare", "rail", 1.0)], [L("gloved", "rail", 1.0), L("bare", "phone", 1.0)], 1.0);
  assert.equal(r.matched, 0);
  assert.equal(r.falseAlarms.length, 2);
});

test("one detection cannot satisfy two labels", () => {
  const r = scoreContacts([L("h", "rail", 1.0), L("h", "rail", 1.5)], [L("h", "rail", 1.2)], 1.0);
  assert.equal(r.matched, 1);
  assert.equal(r.misses.length, 1);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 0.5);
});

test("each label takes the closest free detection", () => {
  const r = scoreContacts([L("h", "rail", 2.0)], [L("h", "rail", 1.2), L("h", "rail", 2.1)], 1.0);
  assert.equal(r.matches[0]!.detected.startT, 2.1);
  assert.equal(r.falseAlarms[0]!.startT, 1.2);
});

test("empty inputs score 1 so a clean run is not penalized", () => {
  const r = scoreContacts([], [], 1.0);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
  const extra = scoreContacts([], [L("h", "rail", 1.0)], 1.0);
  assert.equal(extra.precision, 0);
  assert.equal(extra.recall, 1);
});

test("rejects a negative tolerance", () => {
  assert.throws(() => scoreContacts([], [], -1));
});
