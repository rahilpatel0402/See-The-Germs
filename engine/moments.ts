// WHO Five Moments mapping from zones and contacts, rules exactly as PLAN.md 6.5. Moment 3 is
// out of scope. Pure: the propagation rerun used for downstream impact is passed in.

import { personOf } from "./gloves.ts";
import type { ContactEvent, Entity, HygieneEvent, MomentMiss, PropagationResult } from "./types.ts";

export interface MomentsInput {
  // Contacts with dispensers already removed by splitHygiene.
  readonly contacts: readonly ContactEvent[];
  readonly hygieneEvents: readonly HygieneEvent[];
  readonly entities: readonly Entity[];
}

export type Rerun = (inserted: HygieneEvent) => PropagationResult;

function isPatientZone(zone: string): boolean {
  return zone === "patient_zone_A" || zone === "patient_zone_B";
}

export function detectMomentMisses(input: MomentsInput, base: PropagationResult, rerun: Rerun): MomentMiss[] {
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const entityOf = (id: string): Entity => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`detectMomentMisses: unknown entity ${id}`);
    return e;
  };
  const personOfHand = (handId: string): string => personOf(entityOf(handId));

  // Effective hygiene times per person.
  const hygiene = new Map<string, number[]>();
  for (const h of input.hygieneEvents) {
    if (!h.effective) continue;
    const p = personOfHand(h.handId);
    (hygiene.get(p) ?? hygiene.set(p, []).get(p)!).push(h.t);
  }
  const hygieneBetween = (person: string, t0: number, t1: number): boolean =>
    (hygiene.get(person) ?? []).some((t) => t >= t0 && t <= t1);

  // Contacts per person in time order.
  const perPerson = new Map<string, ContactEvent[]>();
  for (const c of input.contacts) {
    const p = personOfHand(c.handId);
    (perPerson.get(p) ?? perPerson.set(p, []).get(p)!).push(c);
  }

  const found: Array<Omit<MomentMiss, "downstream">> = [];
  for (const [person, list] of perPerson) {
    const contacts = [...list].sort((a, b) => a.startT - b.startT || a.endT - b.endT);
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i] as ContactEvent;
      const e = entityOf(c.entityId);
      const prev = i > 0 ? (contacts[i - 1] as ContactEvent) : undefined;
      const next = i + 1 < contacts.length ? (contacts[i + 1] as ContactEvent) : undefined;

      // Moment 1: before touching a patient. Look back to the last contact outside this patient zone.
      if (e.class === "resident_zone") {
        let outside: ContactEvent | undefined;
        for (let j = i - 1; j >= 0; j--) {
          const cj = contacts[j] as ContactEvent;
          if (entityOf(cj.entityId).zone !== e.zone) {
            outside = cj;
            break;
          }
        }
        if (outside !== undefined && !hygieneBetween(person, outside.endT, c.startT)) {
          found.push({ moment: 1, handId: c.handId, t: c.startT });
        }
      }

      // Moment 2: before a clean or aseptic task.
      if (e.aseptic === true && !hygieneBetween(person, prev?.endT ?? 0, c.startT)) {
        found.push({ moment: 2, handId: c.handId, t: c.startT });
      }

      // Moment 4: after touching a patient, before the healthcare area or another patient zone.
      if (e.class === "resident_zone" && next !== undefined) {
        const nextZone = entityOf(next.entityId).zone;
        if (nextZone !== e.zone && !hygieneBetween(person, c.endT, next.startT)) {
          found.push({ moment: 4, handId: c.handId, t: c.endT });
        }
      }

      // Moment 5: after touching patient surroundings, before leaving that zone for anywhere
      // else: the healthcare area or another patient zone (Rahil, Oct 27).
      if (e.class === "object" && isPatientZone(e.zone) && next !== undefined) {
        const nextZone = entityOf(next.entityId).zone;
        if (nextZone !== e.zone && !hygieneBetween(person, c.endT, next.startT)) {
          found.push({ moment: 5, handId: c.handId, t: c.endT });
        }
      }
    }
  }

  found.sort((a, b) => a.t - b.t || a.moment - b.moment || a.handId.localeCompare(b.handId));
  const baseSet = new Set(base.contaminated);
  return found.map((miss) => {
    const after = rerun({ handId: miss.handId, t: miss.t, agent: "soap_water", effective: true });
    const afterSet = new Set(after.contaminated);
    const downstream = [...baseSet].filter((id) => !afterSet.has(id));
    return { ...miss, downstream };
  });
}
