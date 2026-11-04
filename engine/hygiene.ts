// Turns dispenser contacts into hygiene events and glove box touches, and returns the remaining
// contacts. Dispenser contacts never count as contamination transfer. A hygiene event is
// effective only if the agent clears the pathogen and the rub lasted the WHO duration: the time
// from reaching the dispenser to the next touch is the time the hands were being rubbed. A hand
// that goes back to the same dispenser during that rub (a second squeeze, clip B of the shoot)
// is still the same rub: those contacts fold into one event whose dwell is their sum.

import type { HygieneConfig } from "./config.ts";
import { personOf } from "./gloves.ts";
import { agentClearsHands } from "./pathogens.ts";
import type { ContactEvent, Entity, GloveBoxTouch, HygieneEvent, PathogenProfile } from "./types.ts";

export interface HygieneSplit {
  readonly hygieneEvents: readonly HygieneEvent[];
  readonly gloveBoxTouches: readonly GloveBoxTouch[];
  // Contacts with dispensers removed, in the original order.
  readonly contacts: readonly ContactEvent[];
}

export function splitHygiene(
  contacts: readonly ContactEvent[],
  entities: readonly Entity[],
  profile: PathogenProfile,
  config: HygieneConfig,
  clipDurationS: number = Number.POSITIVE_INFINITY,
): HygieneSplit {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const entityOf = (id: string): Entity => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`splitHygiene: unknown entity ${id}`);
    return e;
  };
  const personOfHand = (handId: string): string => personOf(entityOf(handId));
  const sorted = [...contacts].sort((a, b) => a.startT - b.startT || a.endT - b.endT);

  const hygieneEvents: HygieneEvent[] = [];
  const gloveBoxTouches: GloveBoxTouch[] = [];
  const rest: ContactEvent[] = [];

  // Fold repeat visits to the same dispenser by the same person, with nothing else touched in
  // between, into the first visit. The folded contact keeps the first start and the last end;
  // its dwell is the sum of the visits.
  const folded: Array<{ contact: ContactEvent; dwellS: number }> = [];
  const foldedAway = new Set<ContactEvent>();
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i] as ContactEvent;
    if (foldedAway.has(c) || entityOf(c.entityId).class !== "dispenser") continue;
    let dwellS = c.endT - c.startT;
    let endT = c.endT;
    const person = personOfHand(c.handId);
    for (let j = i + 1; j < sorted.length; j++) {
      const d = sorted[j] as ContactEvent;
      if (personOfHand(d.handId) !== person) continue;
      if (d.entityId !== c.entityId) break;
      dwellS += d.endT - d.startT;
      endT = Math.max(endT, d.endT);
      foldedAway.add(d);
    }
    folded.push({ contact: { ...c, endT }, dwellS });
  }
  const dwellOf = new Map(folded.map((f) => [f.contact, f.dwellS]));
  const merged = [...sorted.filter((c) => entityOf(c.entityId).class !== "dispenser"), ...folded.map((f) => f.contact)].sort((a, b) => a.startT - b.startT || a.endT - b.endT);

  for (const contact of merged) {
    const entity = entityOf(contact.entityId);
    if (entity.class !== "dispenser") {
      rest.push(contact);
      continue;
    }
    if ((dwellOf.get(contact) ?? contact.endT - contact.startT) < config.minDwellS) continue;
    if (entity.agent === undefined) throw new Error(`splitHygiene: dispenser ${entity.id} has no agent`);
    if (entity.agent === "gloves") {
      gloveBoxTouches.push({ handId: contact.handId, t: contact.startT });
      continue;
    }
    const person = personOfHand(contact.handId);
    const next = merged.find((c) => c.startT > contact.endT && c.entityId !== contact.entityId && personOfHand(c.handId) === person);
    const durationS = Math.max(0, (next ? next.startT : clipDurationS) - contact.startT);
    const adequate = durationS >= config.minRubS[entity.agent];
    const clears = agentClearsHands(profile, entity.agent);
    hygieneEvents.push({
      handId: contact.handId,
      t: contact.startT,
      agent: entity.agent,
      durationS: Number.isFinite(durationS) ? Number(durationS.toFixed(2)) : durationS,
      adequate,
      effective: clears && (adequate || !config.inadequateIsIneffective),
    });
  }

  const byT = <T extends { t: number }>(a: T, b: T): number => a.t - b.t;
  return { hygieneEvents: hygieneEvents.sort(byT), gloveBoxTouches: gloveBoxTouches.sort(byT), contacts: rest };
}
