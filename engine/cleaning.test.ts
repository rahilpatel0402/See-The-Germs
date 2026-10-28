import { test } from "node:test";
import assert from "node:assert/strict";
import { cleaningList } from "./cleaning.ts";
import { CLIP_A_CONTACTS, CLIP_A_ENTITIES } from "./fixtures.ts";
import { PATHOGENS } from "./pathogens.ts";
import { propagate } from "./propagation.ts";

test("clip A: every contaminated surface and the resident, source flagged, ranked by contacts", () => {
  const scenario = { sourceEntityId: "rail_A", pathogen: "c_difficile" as const };
  const propagation = propagate({ contacts: CLIP_A_CONTACTS, hygieneEvents: [], gloveEvents: [], entities: CLIP_A_ENTITIES, scenario, profile: PATHOGENS.c_difficile });
  const list = cleaningList(propagation, CLIP_A_CONTACTS, CLIP_A_ENTITIES, scenario, PATHOGENS.c_difficile);
  assert.deepEqual(
    list.items.map((i) => [i.label, i.isSource, i.contactCount, i.firstContaminatedT]),
    [["bed rail A", true, 1, 0], ["IV pole", false, 1, 4], ["phone", false, 1, 7], ["blanket B", false, 1, 12], ["resident B", false, 1, 15]],
  );
  assert.match(list.disinfectantNote, /List K/);
  // Hands and dispensers never appear.
  assert.ok(list.items.every((i) => !["bare_hand", "gloved_hand", "sanitizer"].includes(i.entityId)));
});

test("a clean run lists only the source", () => {
  const scenario = { sourceEntityId: "rail_A", pathogen: "mrsa" as const };
  const propagation = propagate({ contacts: CLIP_A_CONTACTS, hygieneEvents: [{ handId: "bare_hand", t: 3, agent: "alcohol_rub", durationS: 25, adequate: true, effective: true }], gloveEvents: [], entities: CLIP_A_ENTITIES, scenario, profile: PATHOGENS.mrsa });
  const list = cleaningList(propagation, CLIP_A_CONTACTS, CLIP_A_ENTITIES, scenario, PATHOGENS.mrsa);
  assert.deepEqual(list.items.map((i) => i.entityId), ["rail_A"]);
});
