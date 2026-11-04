import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOVE_CONFIG } from "./config.ts";
import { detectGloveEvents, objectBirths } from "./gloves.ts";
import { bbox, fromPattern } from "./masks.ts";
import type { Entity, FrameMask, Tracks } from "./types.ts";

// 20x10 frames at 10 fps. Handover distance limit is 15% of width = 3 px.
const SIZE = { w: 20, h: 10 };
const bare: Entity = { id: "bare_hand", label: "bare hand", class: "bare_hand", zone: "healthcare_area", samPhrase: "bare hand" };
const gloved: Entity = { id: "gloved_hand", label: "gloved hand", class: "gloved_hand", zone: "healthcare_area", samPhrase: "gloved hand" };

function blob(left: number, top: number): FrameMask {
  const rows: string[] = [];
  for (let y = 0; y < SIZE.h; y++) {
    let s = "";
    for (let x = 0; x < SIZE.w; x++) s += x >= left && x < left + 3 && y >= top && y < top + 3 ? "#" : ".";
    rows.push(s);
  }
  return fromPattern(rows);
}

// Timeline of [bareMask | null, glovedMask | null] per frame.
const EMPTY: ReadonlyMap<string, FrameMask> = new Map();

function tracks(frames: Array<[FrameMask | null, FrameMask | null]>): Tracks {
  const map = new Map<number, Map<string, FrameMask>>();
  frames.forEach(([b, g], f) => {
    const m = new Map<string, FrameMask>();
    if (b) m.set(bare.id, b);
    if (g) m.set(gloved.id, g);
    map.set(f, m);
  });
  return { frameSize: SIZE, fps: 10, frameCount: frames.length, entities: [bare, gloved], masksAt: (f) => map.get(f) ?? EMPTY };
}

const near = blob(5, 3);
// A fresh object birth at a mask's box, for objectBirthsAt stubs.
const b = (m: FrameMask, returning = false) => ({ box: bbox(m)!, returning });
const far = blob(15, 3);

test("gloved track appearing where the bare track was is a don, the reverse is a doff", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 30; f++) frames.push([null, near]);
  for (let f = 30; f < 40; f++) frames.push([near, null]);
  const events = detectGloveEvents(tracks(frames), GLOVE_CONFIG);
  assert.deepEqual(events, [
    { handId: "bare_hand", t: 1.0, type: "don", source: "detected" },
    { handId: "bare_hand", t: 3.0, type: "doff", source: "detected" },
  ]);
});

test("the bare class firing through a clear glove does not prevent the don", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 30; f++) frames.push([near, near]);
  const events = detectGloveEvents(tracks(frames), GLOVE_CONFIG);
  assert.deepEqual(events.map((e) => [e.type, e.t]), [["don", 1.0]]);
});

test("a gloved track far from a bare hand that stays in view is a different hand, no don", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 30; f++) frames.push([near, far]);
  assert.deepEqual(detectGloveEvents(tracks(frames), GLOVE_CONFIG), []);
});

test("gloves on from the first frame are reported as a don at 0, and a two frame dropout is not a doff", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([null, near]);
  assert.deepEqual(detectGloveEvents(tracks(frames), GLOVE_CONFIG), [{ handId: "bare_hand", t: 0, type: "don", source: "detected" }]);

  const dropout: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 5; f++) dropout.push([near, null]);
  for (let f = 5; f < 15; f++) dropout.push([null, near]);
  dropout.push([near, null], [near, null]);
  for (let f = 17; f < 25; f++) dropout.push([null, near]);
  const events = detectGloveEvents(tracks(dropout), GLOVE_CONFIG);
  assert.deepEqual(events.map((e) => e.type), ["don"]);
});

test("a gloved hand that leaves the frame without the bare hand reappearing is not a doff", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 5; f++) frames.push([near, null]);
  for (let f = 5; f < 15; f++) frames.push([null, near]);
  for (let f = 15; f < 30; f++) frames.push([null, null]);
  const events = detectGloveEvents(tracks(frames), GLOVE_CONFIG);
  assert.deepEqual(events.map((e) => e.type), ["don"]);
});

test("a glove removed off camera is closed when a fresh handover happens elsewhere", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 5; f++) frames.push([near, null]);
  for (let f = 5; f < 15; f++) frames.push([null, near]);
  for (let f = 15; f < 20; f++) frames.push([null, null]);
  for (let f = 20; f < 30; f++) frames.push([far, null]);
  for (let f = 30; f < 40; f++) frames.push([null, far]);
  const events = detectGloveEvents(tracks(frames), GLOVE_CONFIG);
  assert.deepEqual(events.map((e) => [e.type, e.t]), [["don", 0.5], ["doff", 1.5], ["don", 3.0]]);
});

test("centers come from boundsAt when the source provides it", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 20; f++) frames.push([null, near]);
  const base = tracks(frames);
  let used = 0;
  const withBounds: Tracks = {
    ...base,
    boundsAt: (f) => {
      used++;
      const m = new Map<string, { left: number; top: number; right: number; bottom: number }>();
      for (const [id, mask] of base.masksAt(f)) {
        const b = bbox(mask);
        if (b) m.set(id, b);
      }
      return m;
    },
  };
  const events = detectGloveEvents(withBounds, GLOVE_CONFIG);
  assert.deepEqual(events.map((e) => e.type), ["don"]);
  assert.ok(used > 0);
});

test("a person with only one hand class produces nothing", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([null, near]);
  const t = tracks(frames);
  const onlyGloved: Tracks = { ...t, entities: [gloved] };
  assert.deepEqual(detectGloveEvents(onlyGloved, GLOVE_CONFIG), []);
});

test("a bare-hand object born on the gloved hand is a doff even though the gloved track keeps going", () => {
  // Gloved from the don at frame 10 to the end; SAM keeps following the glove after it comes off
  // (outside footage, Oct 31), so the doff shows only as a new bare object born at frame 25.
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 40; f++) frames.push([f >= 25 ? near : null, near]);
  const base = tracks(frames);
  const births = (bareAt: FrameMask) => (f: number) => (f === 10 ? new Map([[gloved.id, [b(near)]]]) : f === 25 ? new Map([[bare.id, [b(bareAt)]]]) : new Map());
  const withBirths: Tracks = { ...base, objectBirthsAt: births(near) };
  assert.deepEqual(detectGloveEvents(withBirths, GLOVE_CONFIG), [
    { handId: "bare_hand", t: 1.0, type: "don", source: "detected" },
    { handId: "bare_hand", t: 2.5, type: "doff", source: "detected" },
  ]);
  // A bare object born far from the gloved hand is another hand, not a doff.
  const farBirth: Tracks = { ...base, objectBirthsAt: births(far) };
  assert.deepEqual(detectGloveEvents(farBirth, GLOVE_CONFIG).map((e) => e.type), ["don"]);
});

test("gloves already on at the start can still come off: a bare object born on the hand is the doff", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 40; f++) frames.push([f >= 20 ? near : null, near]);
  const t: Tracks = { ...tracks(frames), objectBirthsAt: (f) => (f === 0 ? new Map([[gloved.id, [b(near)]]]) : f === 20 ? new Map([[bare.id, [b(near)]]]) : new Map()) };
  assert.deepEqual(detectGloveEvents(t, GLOVE_CONFIG), [
    { handId: "bare_hand", t: 0, type: "don", source: "detected" },
    { handId: "bare_hand", t: 2.0, type: "doff", source: "detected" },
  ]);
});

test("a fresh gloved object born on the bare hand is a don even while the old gloved track follows the removed glove", () => {
  // Don at 10, skin back at 25 (doff), new glove at 40 while the first glove's track never ends.
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 60; f++) frames.push([f >= 25 ? near : null, near]);
  const births = (f: number) =>
    f === 10 ? new Map([[gloved.id, [b(near)]]]) : f === 25 ? new Map([[bare.id, [b(near)]]]) : f === 40 ? new Map([[gloved.id, [b(near)]]]) : new Map();
  const t: Tracks = { ...tracks(frames), objectBirthsAt: births };
  assert.deepEqual(detectGloveEvents(t, GLOVE_CONFIG).map((e) => [e.type, e.t]), [["don", 1.0], ["doff", 2.5], ["don", 4.0]]);
});

test("a bare object born during a one frame gloved dropout still counts as the doff", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 40; f++) frames.push([f >= 25 ? near : null, f === 25 ? null : near]);
  const births = (f: number) => (f === 10 ? new Map([[gloved.id, [b(near)]]]) : f === 25 ? new Map([[bare.id, [b(near)]]]) : new Map());
  const t: Tracks = { ...tracks(frames), objectBirthsAt: births };
  assert.deepEqual(detectGloveEvents(t, GLOVE_CONFIG).map((e) => [e.type, e.t]), [["don", 1.0], ["doff", 2.5]]);
});

test("with per-object boxes, a bare hand born on one of two gloved hands is a doff even though the union center is far", () => {
  // Two gloved hands 13 px apart on a 20 px frame; handover distance is 3 px.
  const left = blob(1, 3);
  const right = blob(14, 3);
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 30; f++) frames.push([f >= 15 ? left : null, left]);
  const base = tracks(frames);
  const t: Tracks = {
    ...base,
    objectBoundsAt: () => new Map([[gloved.id, [bbox(left)!, bbox(right)!]]]),
    objectBirthsAt: (f) => (f === 0 ? new Map([[gloved.id, [b(left), b(right)]]]) : f === 15 ? new Map([[bare.id, [b(left)]]]) : new Map()),
  };
  assert.deepEqual(detectGloveEvents(t, GLOVE_CONFIG).map((e) => [e.type, e.t]), [["don", 0], ["doff", 1.5]]);
});

test("objectBirths: first sighting and any return after the gap count as births", () => {
  const rec = (frameIndex: number, objectId: string, left: number) => ({ frameIndex, objectId, bounds: { left, top: 0, right: left + 5, bottom: 5 }, mask: { encoding: "one_bit" as const, width: 5, height: 5, payload: "x" } });
  const records = [rec(0, "a", 0), rec(1, "a", 1), rec(2, "a", 2), rec(8, "a", 8), rec(30, "a", 30), rec(5, "b", 50)];
  const births = objectBirths(records, 10);
  assert.deepEqual([...births.keys()].sort((x, y) => x - y), [0, 5, 30]);
  assert.equal(births.get(30)![0]!.box.left, 30);
  assert.deepEqual([births.get(0)![0]!.returning, births.get(30)![0]!.returning], [false, true]);
});

test("a glove appearing right after the bare hands left view is a don, even far from where they were last seen", () => {
  // Clip C of the shoot: the bare hands dip out of frame at the top right to pick up a glove,
  // and the gloved hand appears two frames later at the rail, 700 px away.
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 8; f++) frames.push([far, null]);
  frames.push([null, null], [null, null]);
  for (let f = 10; f < 30; f++) frames.push([null, near]);
  const t: Tracks = { ...tracks(frames), objectBirthsAt: (f) => (f === 10 ? new Map([[gloved.id, [b(near)]]]) : new Map()) };
  assert.deepEqual(detectGloveEvents(t, GLOVE_CONFIG).map((e) => [e.type, e.t]), [["don", 1.0]]);
  // A glove appearing while a bare hand is still visible elsewhere is another person's: no don.
  const other: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 30; f++) other.push([far, f >= 10 ? near : null]);
  const t2: Tracks = { ...tracks(other), objectBirthsAt: (f) => (f === 10 ? new Map([[gloved.id, [b(near)]]]) : new Map()) };
  assert.deepEqual(detectGloveEvents(t2, GLOVE_CONFIG), []);
});

test("a glove object that returns after a gap never dons: it is a removed glove's id on bare skin", () => {
  // Gloves on at 10, off at 30 (skin back), then the old glove id returns on the bare hands at
  // 40 during the rub; a fresh pair (new object) goes on at 60.
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 30; f++) frames.push([null, near]);
  for (let f = 30; f < 60; f++) frames.push([near, f >= 40 ? near : null]);
  for (let f = 60; f < 80; f++) frames.push([null, near]);
  const births = (f: number) =>
    f === 10 ? new Map([[gloved.id, [b(near)]]]) : f === 30 ? new Map([[bare.id, [b(near, true)]]]) : f === 40 ? new Map([[gloved.id, [b(near, true)]]]) : f === 60 ? new Map([[gloved.id, [b(near)]]]) : new Map();
  const t: Tracks = { ...tracks(frames), objectBirthsAt: births };
  assert.deepEqual(detectGloveEvents(t, GLOVE_CONFIG).map((e) => [e.type, e.t]), [["don", 1.0], ["doff", 3.0], ["don", 6.0]]);
});
