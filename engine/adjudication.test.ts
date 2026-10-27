import { test } from "node:test";
import assert from "node:assert/strict";
import { framesFor, planAdjudication } from "./adjudication.ts";
import { ADJUDICATION_CONFIG } from "./config.ts";
import type { Adjudication, ContactCandidate } from "./types.ts";

function cand(n: number, confidence: "confident" | "ambiguous", peak: number): ContactCandidate {
  const startFrame = n * 10;
  return {
    id: `h:o:${startFrame}`,
    handId: "h",
    entityId: "o",
    startT: startFrame / 10,
    endT: (startFrame + 4) / 10,
    startFrame,
    endFrame: startFrame + 3,
    confidence,
    peakIntersectionPx: peak,
    dwellFrames: 4,
  };
}

test("only ambiguous candidates without a verdict are selected, in start order", () => {
  const cands = [cand(3, "ambiguous", 50), cand(1, "confident", 900), cand(2, "ambiguous", 20)];
  const plan = planAdjudication(cands, [], ADJUDICATION_CONFIG);
  assert.deepEqual(plan.selected.map((c) => c.startFrame), [20, 30]);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.frames["h:o:20"], { first: 20, middle: 21 });
});

test("cached verdicts are never re-asked and count against the cap", () => {
  const cands = [cand(1, "ambiguous", 10), cand(2, "ambiguous", 20)];
  const existing: Adjudication[] = [{ candidateId: "h:o:10", verdict: "touching", reasoning: "x" }];
  const plan = planAdjudication(cands, existing, { capPerClip: 1 });
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.skipped.map((c) => c.id), ["h:o:20"]);
});

test("beyond the cap, the lowest overlap candidates are chosen first", () => {
  const cands = [cand(1, "ambiguous", 300), cand(2, "ambiguous", 100), cand(3, "ambiguous", 200), cand(4, "ambiguous", 50)];
  const plan = planAdjudication(cands, [], { capPerClip: 2 });
  assert.deepEqual(plan.selected.map((c) => c.peakIntersectionPx), [100, 50]);
  assert.deepEqual(plan.skipped.map((c) => c.peakIntersectionPx), [300, 200]);
});

test("frames are the first and the middle frame of the window", () => {
  const c = { ...cand(0, "ambiguous", 1), startFrame: 10, endFrame: 25 };
  assert.deepEqual(framesFor(c), { first: 10, middle: 17 });
});

test("same input, same plan", () => {
  const cands = [cand(2, "ambiguous", 20), cand(1, "ambiguous", 20)];
  assert.deepEqual(planAdjudication(cands, [], ADJUDICATION_CONFIG), planAdjudication(cands, [], ADJUDICATION_CONFIG));
});
