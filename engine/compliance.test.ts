import { test } from "node:test";
import assert from "node:assert/strict";
import { complianceFrom, personMapper } from "./compliance.ts";
import { CLIP_A_ENTITIES } from "./fixtures.ts";
import type { MomentOpportunity } from "./types.ts";

const o = (moment: 1 | 2 | 4 | 5, met: boolean, handId = "bare_hand", t = 1): MomentOpportunity => ({ moment, handId, t, met });

test("rates per moment, per person, and overall", () => {
  const entities = [...CLIP_A_ENTITIES, { id: "p2", label: "P2", class: "bare_hand" as const, zone: "healthcare_area" as const, samPhrase: "bare hand", person: "P2" }];
  const c = complianceFrom([o(5, false), o(1, true), o(1, false, "p2"), o(4, true, "p2")], personMapper(entities));
  assert.deepEqual(c.overall, { opportunities: 4, met: 2, rate: 0.5 });
  assert.deepEqual(c.byMoment["1"], { opportunities: 2, met: 1, rate: 0.5 });
  assert.deepEqual(c.byMoment["2"], { opportunities: 0, met: 0, rate: null });
  assert.deepEqual(c.byPerson, { P1: { opportunities: 2, met: 1, rate: 0.5 }, P2: { opportunities: 2, met: 1, rate: 0.5 } });
});

test("no opportunities means no rate, not zero", () => {
  const c = complianceFrom([], personMapper(CLIP_A_ENTITIES));
  assert.equal(c.overall.rate, null);
});
