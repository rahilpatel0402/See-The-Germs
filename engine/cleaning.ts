// The disinfection handoff: every surface and resident zone that is contaminated at the end of
// the clip, ranked by how often a contaminated hand touched it, with the disinfectant class the
// pathogen needs. The audit's practical output for housekeeping. Pure.

import type { CleaningItem, CleaningList, ContactEvent, Entity, PathogenProfile, PropagationResult, Scenario } from "./types.ts";

export function cleaningList(
  propagation: PropagationResult,
  contacts: readonly ContactEvent[],
  entities: readonly Entity[],
  scenario: Scenario,
  profile: PathogenProfile,
): CleaningList {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const firstContaminated = new Map<string, number>();
  for (const change of propagation.changes) {
    if (change.contaminated && !firstContaminated.has(change.entityId)) firstContaminated.set(change.entityId, change.t);
  }
  const items: CleaningItem[] = [];
  for (const id of propagation.contaminated) {
    const e = byId.get(id);
    if (!e || e.class === "bare_hand" || e.class === "gloved_hand" || e.class === "dispenser") continue;
    const firstT = firstContaminated.get(id) ?? 0;
    const contactCount = contacts.filter((c) => c.entityId === id && c.startT >= firstT).length;
    items.push({ entityId: id, label: e.label, zone: e.zone, isSource: id === scenario.sourceEntityId, firstContaminatedT: firstT, contactCount });
  }
  items.sort((a, b) => b.contactCount - a.contactCount || a.firstContaminatedT - b.firstContaminatedT || a.label.localeCompare(b.label));
  return { items, disinfectantNote: profile.disinfectantNote };
}
