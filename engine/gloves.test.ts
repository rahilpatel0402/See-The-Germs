import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOVE_CONFIG } from "./config.ts";
import { detectGloveEvents } from "./gloves.ts";
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

test("a gloved track far from the bare track is a different hand, no don", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([near, null]);
  for (let f = 10; f < 30; f++) frames.push([null, far]);
  assert.deepEqual(detectGloveEvents(tracks(frames), GLOVE_CONFIG), []);
});

test("gloved from the first frame is not a don, and a two frame dropout is not a doff", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([null, near]);
  assert.deepEqual(detectGloveEvents(tracks(frames), GLOVE_CONFIG), []);

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
  const withBirths: Tracks = { ...base, objectBirthsAt: (f) => (f === 25 ? new Map([[bare.id, [bbox(near)]]]) : new Map()) };
  assert.deepEqual(detectGloveEvents(withBirths, GLOVE_CONFIG), [
    { handId: "bare_hand", t: 1.0, type: "don", source: "detected" },
    { handId: "bare_hand", t: 2.5, type: "doff", source: "detected" },
  ]);
  // A bare object born far from the gloved hand is another hand, not a doff.
  const farBirth: Tracks = { ...base, objectBirthsAt: (f) => (f === 25 ? new Map([[bare.id, [bbox(far)]]]) : new Map()) };
  assert.deepEqual(detectGloveEvents(farBirth, GLOVE_CONFIG).map((e) => e.type), ["don"]);
});

test("gloves already on at the start can still come off: a bare object born on the hand is the doff", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 40; f++) frames.push([f >= 20 ? near : null, near]);
  const t: Tracks = { ...tracks(frames), objectBirthsAt: (f) => (f === 20 ? new Map([[bare.id, [bbox(near)]]]) : new Map()) };
  assert.deepEqual(detectGloveEvents(t, GLOVE_CONFIG), [{ handId: "bare_hand", t: 2.0, type: "doff", source: "detected" }]);
});
