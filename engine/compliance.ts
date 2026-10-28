// Hand hygiene compliance: met opportunities over all opportunities, the number an infection
// preventionist reports (WHO observation form). Per Moment, per person, and overall. Pure, and
// the same function aggregates across clips.

import { personOf } from "./gloves.ts";
import type { Compliance, ComplianceCell, Entity, MomentOpportunity } from "./types.ts";

function cell(list: readonly MomentOpportunity[]): ComplianceCell {
  const met = list.filter((o) => o.met).length;
  return { opportunities: list.length, met, rate: list.length === 0 ? null : met / list.length };
}

// personOfHand maps a hand entity id to a person label; opportunities from several clips may
// share hand ids, so the caller passes the mapping.
export function complianceFrom(opportunities: readonly MomentOpportunity[], personOfHand: (handId: string) => string): Compliance {
  const byPerson = new Map<string, MomentOpportunity[]>();
  for (const o of opportunities) {
    const p = personOfHand(o.handId);
    (byPerson.get(p) ?? byPerson.set(p, []).get(p)!).push(o);
  }
  const persons: Record<string, ComplianceCell> = {};
  for (const [p, list] of byPerson) persons[p] = cell(list);
  return {
    overall: cell(opportunities),
    byMoment: {
      "1": cell(opportunities.filter((o) => o.moment === 1)),
      "2": cell(opportunities.filter((o) => o.moment === 2)),
      "4": cell(opportunities.filter((o) => o.moment === 4)),
      "5": cell(opportunities.filter((o) => o.moment === 5)),
    },
    byPerson: persons,
  };
}

export function personMapper(entities: readonly Entity[]): (handId: string) => string {
  const byId = new Map(entities.map((e) => [e.id, e]));
  return (handId) => {
    const e = byId.get(handId);
    return e ? personOf(e) : handId;
  };
}
