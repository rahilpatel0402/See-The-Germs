// Glove use rules. Gloves do not replace hand hygiene (WHO glove use information leaflet, CDC
// hand hygiene in healthcare settings). Four checks, each a GloveIssue with a time and the
// entities involved:
// - no_hygiene_before_don: no effective hygiene between the last contact and putting gloves on.
// - no_hygiene_after_doff: no effective hygiene between taking gloves off and the next contact.
// - glove_across_residents: one pair of gloves touched two different residents.
// - gloved_healthcare_area_contact: a gloved hand touched a healthcare-area object (phone, cart).
// Pure.

import { personOf } from "./gloves.ts";
import type { ContactEvent, Entity, GloveEvent, GloveIssue, HygieneEvent } from "./types.ts";

export interface GloveRulesInput {
  // Contacts with dispensers already removed by splitHygiene.
  readonly contacts: readonly ContactEvent[];
  readonly hygieneEvents: readonly HygieneEvent[];
  readonly gloveEvents: readonly GloveEvent[];
  readonly entities: readonly Entity[];
  readonly clipDurationS: number;
}

interface GloveInterval {
  readonly person: string;
  readonly handId: string;
  readonly on: number;
  readonly off: number | null;
}

export function detectGloveIssues(input: GloveRulesInput): GloveIssue[] {
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const entityOf = (id: string): Entity => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`detectGloveIssues: unknown entity ${id}`);
    return e;
  };
  const personOfHand = (handId: string): string => personOf(entityOf(handId));
  const hygiene = new Map<string, number[]>();
  for (const h of input.hygieneEvents) {
    if (!h.effective) continue;
    const p = personOfHand(h.handId);
    (hygiene.get(p) ?? hygiene.set(p, []).get(p)!).push(h.t);
  }
  const hygieneBetween = (person: string, t0: number, t1: number): boolean => (hygiene.get(person) ?? []).some((t) => t >= t0 && t <= t1);
  const contacts = [...input.contacts].sort((a, b) => a.startT - b.startT || a.endT - b.endT);

  // Glove intervals per person from don and doff pairs.
  const intervals: GloveInterval[] = [];
  const open = new Map<string, GloveInterval>();
  for (const g of [...input.gloveEvents].sort((a, b) => a.t - b.t)) {
    const person = personOfHand(g.handId);
    if (g.type === "don") {
      if (!open.has(person)) open.set(person, { person, handId: g.handId, on: g.t, off: null });
    } else {
      const current = open.get(person);
      if (current) {
        intervals.push({ ...current, off: g.t });
        open.delete(person);
      }
    }
  }
  for (const current of open.values()) intervals.push(current);

  const issues: GloveIssue[] = [];
  for (const iv of intervals) {
    const end = iv.off ?? input.clipDurationS;
    const own = contacts.filter((c) => personOfHand(c.handId) === iv.person);

    // Before donning: hygiene since the last contact that ended before the don.
    const before = own.filter((c) => c.endT <= iv.on).at(-1);
    if (before !== undefined && !hygieneBetween(iv.person, before.endT, iv.on)) {
      issues.push({ type: "no_hygiene_before_don", handId: iv.handId, t: iv.on, entityIds: [before.entityId] });
    }

    // After doffing: hygiene before the next contact.
    if (iv.off !== null) {
      const next = own.find((c) => c.startT >= iv.off!);
      if (next !== undefined && !hygieneBetween(iv.person, iv.off, next.startT)) {
        issues.push({ type: "no_hygiene_after_doff", handId: iv.handId, t: iv.off, entityIds: [next.entityId] });
      }
    }

    // While gloved.
    const during = own.filter((c) => c.startT >= iv.on && c.startT < end);
    const residents = [...new Set(during.filter((c) => entityOf(c.entityId).class === "resident_zone").map((c) => c.entityId))];
    if (residents.length > 1) {
      const second = during.find((c) => c.entityId === residents[1]) as ContactEvent;
      issues.push({ type: "glove_across_residents", handId: iv.handId, t: second.startT, entityIds: residents });
    }
    for (const c of during) {
      const e = entityOf(c.entityId);
      if (e.class === "object" && e.zone === "healthcare_area") {
        issues.push({ type: "gloved_healthcare_area_contact", handId: c.handId, t: c.startT, entityIds: [c.entityId] });
      }
    }
  }

  issues.sort((a, b) => a.t - b.t || a.type.localeCompare(b.type));
  return issues;
}
