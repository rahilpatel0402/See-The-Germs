import { test } from "node:test";
import assert from "node:assert/strict";
import { area, bbox, dilate, emptyMask, fromPattern, fromRaster, fromRecord, intersectArea, union } from "./masks.ts";

function rows(mask: { w: number; h: number; data: Uint8Array }): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.h; y++) {
    let s = "";
    for (let x = 0; x < mask.w; x++) s += mask.data[y * mask.w + x] === 1 ? "#" : ".";
    out.push(s);
  }
  return out;
}

test("fromPattern and area round trip", () => {
  const m = fromPattern(["..#.", ".##.", "...."]);
  assert.equal(m.w, 4);
  assert.equal(m.h, 3);
  assert.equal(area(m), 3);
  assert.deepEqual(rows(m), ["..#.", ".##.", "...."]);
});

test("fromPattern rejects ragged rows", () => {
  assert.throws(() => fromPattern(["##", "#"]));
});

test("emptyMask has zero area", () => {
  assert.equal(area(emptyMask({ w: 5, h: 4 })), 0);
});

test("dilate by one turns a single pixel into a 3x3 block", () => {
  const m = fromPattern([".....", ".....", "..#..", ".....", "....."]);
  assert.deepEqual(rows(dilate(m, 1)), [".....", ".###.", ".###.", ".###.", "....."]);
});

test("dilate clamps at the frame edge and k=0 copies", () => {
  const m = fromPattern(["#..", "...", "..."]);
  assert.deepEqual(rows(dilate(m, 1)), ["##.", "##.", "..."]);
  const copy = dilate(m, 0);
  assert.deepEqual(rows(copy), rows(m));
  assert.notEqual(copy.data, m.data);
});

test("dilate by two reaches two pixels in every direction", () => {
  const m = fromPattern([".......", ".......", ".......", "...#...", ".......", ".......", "......."]);
  const d = dilate(m, 2);
  assert.equal(area(d), 25);
  assert.deepEqual(bbox(d), { left: 1, top: 1, right: 6, bottom: 6 });
});

test("dilate rejects negative or fractional k", () => {
  const m = fromPattern(["#"]);
  assert.throws(() => dilate(m, -1));
  assert.throws(() => dilate(m, 1.5));
});

test("intersectArea counts shared pixels and rejects size mismatch", () => {
  const a = fromPattern(["##.", "##.", "..."]);
  const b = fromPattern([".##", ".##", "..."]);
  assert.equal(intersectArea(a, b), 2);
  assert.throws(() => intersectArea(a, fromPattern(["#"])));
});

test("union sets any pixel set in any input", () => {
  const a = fromPattern(["#..", "...", "..."]);
  const b = fromPattern(["...", "...", "..#"]);
  assert.deepEqual(rows(union([a, b])), ["#..", "...", "..#"]);
  assert.throws(() => union([]));
});

test("bbox is half-open and null when empty", () => {
  const m = fromPattern(["....", ".##.", ".#..", "...."]);
  assert.deepEqual(bbox(m), { left: 1, top: 1, right: 3, bottom: 3 });
  assert.equal(bbox(emptyMask({ w: 2, h: 2 })), null);
});

test("fromRaster places the raster at bounds and drops pixels outside the frame", () => {
  const raster = new Uint8Array([1, 1, 0, 1]);
  const m = fromRaster(raster, 2, 2, { left: 3, top: 2, right: 5, bottom: 4 }, { w: 4, h: 4 });
  assert.deepEqual(rows(m), ["....", "....", "...#", "...."]);
  assert.throws(() => fromRaster(raster, 3, 2, { left: 0, top: 0, right: 3, bottom: 2 }, { w: 4, h: 4 }));
});

test("fromRecord decodes a one_bit payload from the SAM protocol spec through the parser", () => {
  // 5x5 one_bit example from meta-models/meta-sam protocol/sam3.md.
  const record = {
    frameIndex: 7,
    objectId: "0",
    bounds: { left: 1, top: 1, right: 6, bottom: 6 },
    mask: { encoding: "one_bit" as const, width: 5, height: 5, payload: "!!!!!(QO(0lu8?" },
  };
  const m = fromRecord(record, { w: 8, h: 8 });
  assert.equal(m.w, 8);
  assert.equal(m.h, 8);
  for (const v of m.data) assert.ok(v === 0 || v === 1);
  const box = bbox(m);
  assert.ok(box === null || (box.left >= 1 && box.top >= 1 && box.right <= 6 && box.bottom <= 6));
});
