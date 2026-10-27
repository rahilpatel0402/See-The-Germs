// Turns dispenser contacts into hygiene events and glove box touches, and returns the remaining
// contacts. Dispenser contacts never count as contamination transfer.

import type { HygieneConfig } from "./config.ts";
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
): HygieneSplit {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const hygieneEvents: HygieneEvent[] = [];
  const gloveBoxTouches: GloveBoxTouch[] = [];
  const rest: ContactEvent[] = [];

  for (const contact of contacts) {
    const entity = byId.get(contact.entityId);
    if (entity === undefined) throw new Error(`splitHygiene: unknown entity ${contact.entityId}`);
    if (entity.class !== "dispenser") {
      rest.push(contact);
      continue;
    }
    if (contact.endT - contact.startT < config.minDwellS) continue;
    if (entity.agent === undefined) throw new Error(`splitHygiene: dispenser ${entity.id} has no agent`);
    if (entity.agent === "gloves") {
      gloveBoxTouches.push({ handId: contact.handId, t: contact.startT });
    } else {
      hygieneEvents.push({
        handId: contact.handId,
        t: contact.startT,
        agent: entity.agent,
        effective: agentClearsHands(profile, entity.agent),
      });
    }
  }

  const byT = <T extends { t: number }>(a: T, b: T): number => a.t - b.t;
  return { hygieneEvents: hygieneEvents.sort(byT), gloveBoxTouches: gloveBoxTouches.sort(byT), contacts: rest };
}
