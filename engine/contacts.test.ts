import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTACT_CONFIG, dilationPx, scaledFloorPx } from "./config.ts";
import { detectContacts } from "./contacts.ts";
import { fromPattern } from "./masks.ts";
import type { Entity, FrameMask, Tracks } from "./types.ts";

// 10x10 frames at 10 fps. At this size the floor scales to 1 px and dilation to 1 px, so a
// "touch" is any overlap after a one pixel dilation.
const SIZE = { w: 10, h: 10 };
const FPS = 10;

const hand: Entity = { id: "h1", label: "bare hand", class: "bare_hand", zone: "healthcare_area", samPhrase: "bare hand" };
const glove: Entity = { id: "h2", label: "gloved hand", class: "gloved_hand", zone: "healthcare_area", samPhrase: "gloved hand" };
const rail: Entity = { id: "rail", label: "bed rail A", class: "object", zone: "patient_zone_A", samPhrase: "white rod" };
const pump: Entity = { id: "pump", label: "sanitizer", class: "dispenser", zone: "hygiene_station", samPhrase: "pump bottle" };

// Object: rows 6..7, cols 2..7. Fixed in every frame.
const railMask = fromPattern([
  "..........", "..........", "..........", "..........", "..........", "..........",
  "..######..", "..######..", "..........", "..........",
]);
// Hand touching: rows 4..5, cols 3..6. One pixel dilation reaches row 6, overlapping the rail.
const handTouch = fromPattern([
  "..........", "..........", "..........", "..........", "...####...", "...####...",
  "..........", "..........", "..........", "..........",
]);
// Hand far away: rows 0..1.
const handAway = fromPattern([
  "...####...", "...####...", "..........", "..........", "..........", "..........",
  "..........", "..........", "..........", "..........",
]);
// Hand overlapping the rail directly: rows 6..7, cols 3..6 (8 px raw, 12 px after 1 px dilation).
const handGrip = fromPattern([
  "..........", "..........", "..........", "..........", "..........", "..........",
  "...####...", "...####...", "..........", "..........",
]);

function tracks(entities: Entity[], perFrame: Array<Record<string, FrameMask | undefined>>): Tracks {
  const frames = new Map<number, Map<string, FrameMask>>();
  perFrame.forEach((masks, f) => {
    const m = new Map<string, FrameMask>();
    for (const [id, mask] of Object.entries(masks)) if (mask) m.set(id, mask);
    frames.set(f, m);
  });
  return { frameSize: SIZE, fps: FPS, entities, frames };
}

function seq(hits: boolean[], handMask = handTouch): Array<Record<string, FrameMask | undefined>> {
  return hits.map((hit) => ({ rail: railMask, h1: hit ? handMask : handAway }));
}

test("config scaling gives 1 px floor and 1 px dilation at 10x10, 150 px and 19 px at 1280x720", () => {
  assert.equal(scaledFloorPx(CONTACT_CONFIG, SIZE), 1);
  assert.equal(dilationPx(CONTACT_CONFIG, SIZE), 1);
  assert.equal(scaledFloorPx(CONTACT_CONFIG, { w: 1280, h: 720 }), 150);
  assert.equal(dilationPx(CONTACT_CONFIG, { w: 1280, h: 720 }), 19);
});

test("a sustained grip becomes one confident candidate with the right timing", () => {
  // away x2, grip x8 (frames 2..9), away x5
  const hits = [false, false, true, true, true, true, true, true, true, true, false, false, false, false, false];
  const out = detectContacts(tracks([hand, rail], seq(hits, handGrip)), CONTACT_CONFIG);
  assert.equal(out.length, 1);
  const c = out[0]!;
  assert.equal(c.handId, "h1");
  assert.equal(c.entityId, "rail");
  assert.equal(c.startFrame, 2);
  assert.equal(c.endFrame, 9);
  assert.equal(c.startT, 0.2);
  assert.equal(c.endT, 1.0);
  assert.equal(c.dwellFrames, 8);
  assert.equal(c.confidence, "confident");
  assert.equal(c.peakIntersectionPx, 12);
  assert.equal(c.id, "h1:rail:2");
});

test("a three frame graze opens a candidate but is ambiguous", () => {
  const hits = [false, true, true, true, false, false, false, false];
  const out = detectContacts(tracks([hand, rail], seq(hits)), CONTACT_CONFIG);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.confidence, "ambiguous");
  assert.equal(out[0]!.dwellFrames, 3);
});

test("two frames of overlap never open a candidate", () => {
  const hits = [false, true, true, false, false, false, false];
  const out = detectContacts(tracks([hand, rail], seq(hits, handGrip)), CONTACT_CONFIG);
  assert.equal(out.length, 0);
});

test("a thin overlap with long dwell is ambiguous, a thick one is confident", () => {
  // handTouch only overlaps after dilation, peak 6 px here which is >= 2x the 1 px floor, so
  // make the thin case explicit with a one pixel wide hand.
  const thin = fromPattern([
    "..........", "..........", "..........", "..........", "..........", ".....#....",
    "..........", "..........", "..........", "..........",
  ]);
  const hits = [true, true, true, true, true, true, false, false, false];
  const thinOut = detectContacts(tracks([hand, rail], seq(hits, thin)), CONTACT_CONFIG);
  assert.equal(thinOut.length, 1);
  // Peak is 1 px after dilation reaches row 6 over cols 4..6 = 3 px, which is >= 2, so widen the floor.
  const strict = { ...CONTACT_CONFIG, confidentIntersectionFactor: 10 };
  const strictOut = detectContacts(tracks([hand, rail], seq(hits, thin)), strict);
  assert.equal(strictOut[0]!.confidence, "ambiguous");
  const gripOut = detectContacts(tracks([hand, rail], seq(hits, handGrip)), strict);
  assert.equal(gripOut[0]!.confidence, "confident");
});

test("a gap shorter than closeFrames does not split a candidate, a longer gap does", () => {
  const short = [true, true, true, true, true, false, false, true, true, true, true, false, false, false];
  const one = detectContacts(tracks([hand, rail], seq(short, handGrip)), CONTACT_CONFIG);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.startFrame, 0);
  assert.equal(one[0]!.endFrame, 10);
  assert.equal(one[0]!.dwellFrames, 9);

  const long = [true, true, true, true, true, false, false, false, true, true, true, true, true, false, false, false];
  const two = detectContacts(tracks([hand, rail], seq(long, handGrip)), CONTACT_CONFIG);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((c) => [c.startFrame, c.endFrame]), [[0, 4], [8, 12]]);
});

test("a candidate still open at the last frame is closed there", () => {
  const hits = [false, true, true, true, true, true];
  const out = detectContacts(tracks([hand, rail], seq(hits, handGrip)), CONTACT_CONFIG);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.endFrame, 5);
});

test("a frame where the hand is missing counts as a miss", () => {
  const perFrame: Array<Record<string, FrameMask | undefined>> = [];
  for (let f = 0; f < 5; f++) perFrame.push({ rail: railMask, h1: handGrip });
  for (let f = 0; f < 3; f++) perFrame.push({ rail: railMask, h1: undefined });
  for (let f = 0; f < 5; f++) perFrame.push({ rail: railMask, h1: handGrip });
  const out = detectContacts(tracks([hand, rail], perFrame), CONTACT_CONFIG);
  assert.equal(out.length, 2);
});

test("hands never produce candidates against other hands, dispensers do", () => {
  const perFrame: Array<Record<string, FrameMask | undefined>> = [];
  for (let f = 0; f < 6; f++) perFrame.push({ h1: handGrip, h2: handGrip, pump: railMask });
  const out = detectContacts(tracks([hand, glove, pump], perFrame), CONTACT_CONFIG);
  assert.deepEqual(out.map((c) => `${c.handId}->${c.entityId}`).sort(), ["h1->pump", "h2->pump"]);
});

test("output is deterministic and sorted by start frame", () => {
  const perFrame: Array<Record<string, FrameMask | undefined>> = [];
  for (let f = 0; f < 4; f++) perFrame.push({ rail: railMask, pump: railMask, h1: handAway });
  for (let f = 0; f < 6; f++) perFrame.push({ rail: railMask, pump: railMask, h1: handGrip });
  const t = tracks([hand, rail, pump], perFrame);
  const a = detectContacts(t, CONTACT_CONFIG);
  const b = detectContacts(t, CONTACT_CONFIG);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((c) => c.entityId), ["pump", "rail"]);
});

test("rejects a non-positive fps", () => {
  const t = { ...tracks([hand, rail], seq([true, true, true])), fps: 0 };
  assert.throws(() => detectContacts(t, CONTACT_CONFIG));
});
