import { test } from "node:test";
import assert from "node:assert/strict";
import { GAP_FILL_CONFIG } from "./config.ts";
import { boxIoU, fillObjectGaps } from "./persistence.ts";
import type { MaskRecord } from "./types.ts";

const rec = (frameIndex: number, left: number, top: number, objectId = "0"): MaskRecord => ({
  frameIndex,
  objectId,
  bounds: { left, top, right: left + 20, bottom: top + 10 },
  mask: { encoding: "one_bit", width: 20, height: 10, payload: "x" },
});

const framesOf = (records: readonly MaskRecord[]) => records.map((r) => r.frameIndex);
const inferredFrames = (records: readonly MaskRecord[]) => records.filter((r) => r.inferred).map((r) => r.frameIndex);

test("boxIoU", () => {
  const a = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.equal(boxIoU(a, a), 1);
  assert.equal(boxIoU(a, { left: 10, top: 0, right: 20, bottom: 10 }), 0);
  assert.equal(boxIoU(a, { left: 5, top: 0, right: 15, bottom: 10 }), 50 / 150);
});

test("a static object seen at 16 and 20 is filled across the gap and back to frame 0", () => {
  const out = fillObjectGaps([rec(16, 100, 100), rec(20, 101, 100)], 25, GAP_FILL_CONFIG);
  assert.deepEqual(framesOf(out), [...Array(25).keys()]);
  assert.deepEqual(inferredFrames(out), [...Array(25).keys()].filter((f) => f !== 16 && f !== 20));
  // Backfilled frames carry the first sighting's bounds.
  assert.equal(out[0]!.bounds.left, 100);
  assert.equal(out[24]!.bounds.left, 101);
});

test("a moved object fills at most maxMovingGapFrames on each side of the gap", () => {
  const out = fillObjectGaps([rec(10, 0, 0), rec(50, 500, 500)], 60, { ...GAP_FILL_CONFIG, backfillFromFirstSighting: false, forwardFillToEnd: false });
  const inferred = inferredFrames(out);
  assert.deepEqual(inferred, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
  assert.equal(out.find((r) => r.frameIndex === 15)!.bounds.left, 0);
  assert.equal(out.find((r) => r.frameIndex === 45)!.bounds.left, 500);
});

test("a short gap for a moved object is split without overlap", () => {
  const out = fillObjectGaps([rec(10, 0, 0), rec(14, 500, 500)], 20, { ...GAP_FILL_CONFIG, backfillFromFirstSighting: false, forwardFillToEnd: false });
  assert.deepEqual(inferredFrames(out), [11, 12, 13]);
  assert.equal(out.filter((r) => r.frameIndex === 12).length, 1);
});

test("every record of a sighting frame is carried together and already inferred records are not re-used", () => {
  const two = [rec(5, 0, 0, "0"), rec(5, 50, 0, "1"), { ...rec(6, 0, 0), inferred: true }];
  const out = fillObjectGaps(two, 8, GAP_FILL_CONFIG);
  assert.equal(out.filter((r) => r.frameIndex === 7).length, 2);
  assert.equal(out.filter((r) => r.frameIndex === 6 && r.objectId === "1").length, 1);
});

test("disabled returns the input unchanged and empty input stays empty", () => {
  const input = [rec(3, 0, 0)];
  assert.deepEqual(fillObjectGaps(input, 10, { ...GAP_FILL_CONFIG, enabled: false }), input);
  assert.deepEqual(fillObjectGaps([], 10, GAP_FILL_CONFIG), []);
});
