// WHO Five Moments mapping from zones and contacts, rules from PLAN.md 6.5 as confirmed by
// Rahil on Oct 27. Moment 3 is out of scope. Pure: the propagation rerun used for downstream
// impact is passed in.
//
// Every point where a rule applies is an opportunity, met or missed, which is what a hand
// hygiene compliance rate is made of. Zone episodes: consecutive contacts of one person inside
// one zone form an episode. Leaving a patient zone is one opportunity: Moment 4 if the resident
// was touched during the episode, otherwise Moment 5 (WHO: after touching patient surroundings
// without touching the patient). Moment 1 is one opportunity per arrival at a resident, Moment 2
// one per approach to an aseptic task.

import { personOf } from "./gloves.ts";
import type { ContactEvent, Entity, HygieneEvent, MomentMiss, MomentOpportunity, PropagationResult } from "./types.ts";

export interface MomentsInput {
  // Contacts with dispensers already removed by splitHygiene.
  readonly contacts: readonly ContactEvent[];
  readonly hygieneEvents: readonly HygieneEvent[];
  readonly entities: readonly Entity[];
}

export type Rerun = (inserted: HygieneEvent) => PropagationResult;

export interface MomentsResult {
  readonly opportunities: readonly MomentOpportunity[];
  readonly misses: readonly MomentMiss[];
}

function isPatientZone(zone: string): boolean {
  return zone === "patient_zone_A" || zone === "patient_zone_B";
}

export function detectMomentOpportunities(input: MomentsInput): MomentOpportunity[] {
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const entityOf = (id: string): Entity => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`detectMomentOpportunities: unknown entity ${id}`);
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

  const perPerson = new Map<string, ContactEvent[]>();
  for (const c of input.contacts) {
    const p = personOfHand(c.handId);
    (perPerson.get(p) ?? perPerson.set(p, []).get(p)!).push(c);
  }

  const found: MomentOpportunity[] = [];
  for (const [person, list] of perPerson) {
    const contacts = [...list].sort((a, b) => a.startT - b.startT || a.endT - b.endT);
    const chargedOutside = new Set<number>();
    const chargedAseptic = new Set<number>();

    let episodeZone: string | null = null;
    let episodeTouchedResident = false;
    let episodeLastEnd = 0;
    let episodeHandId = "";

    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i] as ContactEvent;
      const e = entityOf(c.entityId);

      // Leaving a patient zone: Moment 4 or Moment 5, once per departure.
      if (episodeZone !== null && e.zone !== episodeZone) {
        if (isPatientZone(episodeZone)) {
          found.push({ moment: episodeTouchedResident ? 4 : 5, handId: episodeHandId, t: episodeLastEnd, met: hygieneBetween(person, episodeLastEnd, c.startT) });
        }
        episodeTouchedResident = false;
      }
      const sameEpisode = episodeZone === e.zone;
      episodeZone = e.zone;
      if (e.class === "resident_zone") episodeTouchedResident = true;
      episodeLastEnd = sameEpisode ? Math.max(episodeLastEnd, c.endT) : c.endT;
      episodeHandId = c.handId;

      // Moment 1: before touching a patient, once per arrival from outside the zone.
      if (e.class === "resident_zone") {
        let outside: ContactEvent | undefined;
        let outsideIndex = -1;
        for (let j = i - 1; j >= 0; j--) {
          const cj = contacts[j] as ContactEvent;
          if (entityOf(cj.entityId).zone !== e.zone) {
            outside = cj;
            outsideIndex = j;
            break;
          }
        }
        if (outside !== undefined && !chargedOutside.has(outsideIndex)) {
          chargedOutside.add(outsideIndex);
          found.push({ moment: 1, handId: c.handId, t: c.startT, met: hygieneBetween(person, outside.endT, c.startT) });
        }
      }

      // Moment 2: before a clean or aseptic task, once per approach.
      if (e.aseptic === true) {
        let prevIndex = -1;
        for (let j = i - 1; j >= 0; j--) {
          if (entityOf((contacts[j] as ContactEvent).entityId).aseptic !== true) {
            prevIndex = j;
            break;
          }
        }
        if (!chargedAseptic.has(prevIndex)) {
          chargedAseptic.add(prevIndex);
          const from = prevIndex >= 0 ? (contacts[prevIndex] as ContactEvent).endT : 0;
          found.push({ moment: 2, handId: c.handId, t: c.startT, met: hygieneBetween(person, from, c.startT) });
        }
      }
    }
  }

  found.sort((a, b) => a.t - b.t || a.moment - b.moment || a.handId.localeCompare(b.handId));
  return found;
}

export function detectMoments(input: MomentsInput, base: PropagationResult, rerun: Rerun): MomentsResult {
  const opportunities = detectMomentOpportunities(input);
  const baseSet = new Set(base.contaminated);
  const misses: MomentMiss[] = opportunities
    .filter((o) => !o.met)
    .map((o) => {
      const after = rerun({ handId: o.handId, t: o.t, agent: "soap_water", durationS: Number.POSITIVE_INFINITY, adequate: true, effective: true });
      const afterSet = new Set(after.contaminated);
      const downstream = [...baseSet].filter((id) => !afterSet.has(id));
      return { moment: o.moment, handId: o.handId, t: o.t, downstream };
    });
  return { opportunities, misses };
}

export function detectMomentMisses(input: MomentsInput, base: PropagationResult, rerun: Rerun): MomentMiss[] {
  return [...detectMoments(input, base, rerun).misses];
}
