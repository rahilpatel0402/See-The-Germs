import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOVE_CONFIG } from "./config.ts";
import { detectGloveEvents } from "./gloves.ts";
import { fromPattern } from "./masks.ts";
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

test("a person with only one hand class produces nothing", () => {
  const frames: Array<[FrameMask | null, FrameMask | null]> = [];
  for (let f = 0; f < 10; f++) frames.push([null, near]);
  const t = tracks(frames);
  const onlyGloved: Tracks = { ...t, entities: [gloved] };
  assert.deepEqual(detectGloveEvents(onlyGloved, GLOVE_CONFIG), []);
});
