// Contamination propagation: a small state machine over entities and hands, driven by a merged
// timeline of glove, hygiene, and contact events. Pure and deterministic. Rules are PLAN.md 6.4.

import { DOFF_EXPOSES_BARE_HAND } from "./config.ts";
import { personOf } from "./gloves.ts";
import type {
  ContactEvent,
  ContaminationChange,
  Entity,
  GloveEvent,
  HandState,
  HygieneEvent,
  PathogenProfile,
  PropagationResult,
  ResidentExposure,
  Scenario,
  TransferEdge,
} from "./types.ts";

export interface PropagationInput {
  // Contacts with dispensers already removed by splitHygiene.
  readonly contacts: readonly ContactEvent[];
  readonly hygieneEvents: readonly HygieneEvent[];
  readonly gloveEvents: readonly GloveEvent[];
  readonly entities: readonly Entity[];
  readonly scenario: Scenario;
  readonly profile: PathogenProfile;
}

type Item =
  | { readonly t: number; readonly order: 0; readonly index: number; readonly kind: "glove"; readonly event: GloveEvent }
  | { readonly t: number; readonly order: 1; readonly index: number; readonly kind: "hygiene"; readonly event: HygieneEvent }
  | { readonly t: number; readonly order: 2; readonly index: number; readonly kind: "contact"; readonly event: ContactEvent };

interface MutableHand {
  contaminated: boolean;
  gloved: boolean;
  preGloveContaminated: boolean;
}

function isHand(entity: Entity): boolean {
  return entity.class === "bare_hand" || entity.class === "gloved_hand";
}

// Hands of one person share state, so a change on one hand entity applies to all of them.
function handGroups(entities: readonly Entity[]): Map<string, readonly string[]> {
  const byPerson = new Map<string, string[]>();
  for (const e of entities) {
    if (!isHand(e)) continue;
    const p = personOf(e);
    (byPerson.get(p) ?? byPerson.set(p, []).get(p)!).push(e.id);
  }
  const groups = new Map<string, readonly string[]>();
  for (const ids of byPerson.values()) for (const id of ids) groups.set(id, ids);
  return groups;
}

// The set of contaminated entity ids at time t, replayed from the change list. Used by the
// overlay for every frame, so it must agree with propagate's final state at the end of the clip.
export function contaminatedAt(entities: readonly Entity[], propagation: PropagationResult, t: number): Set<string> {
  const groups = handGroups(entities);
  const set = new Set<string>();
  for (const change of propagation.changes) {
    if (change.t > t) break;
    for (const id of groups.get(change.entityId) ?? [change.entityId]) {
      if (change.contaminated) set.add(id);
      else set.delete(id);
    }
  }
  return set;
}

// Entities that received contamination within the last windowS seconds before t, for the pulse.
export function recentlyContaminated(entities: readonly Entity[], propagation: PropagationResult, t: number, windowS: number): Set<string> {
  const groups = handGroups(entities);
  const set = new Set<string>();
  for (const edge of propagation.transfers) {
    if (edge.t <= t && edge.t > t - windowS) for (const id of groups.get(edge.toId) ?? [edge.toId]) set.add(id);
  }
  return set;
}

// Seconds each entity has spent contaminated up to time t, replayed from the change list. The
// heat view scales fill by this over elapsed time, so a surface that has been dirty since the
// start reads hotter than one that just turned.
export function contaminatedDurationsAt(entities: readonly Entity[], propagation: PropagationResult, t: number): Map<string, number> {
  const groups = handGroups(entities);
  const since = new Map<string, number>();
  const total = new Map<string, number>();
  for (const change of propagation.changes) {
    if (change.t > t) break;
    for (const id of groups.get(change.entityId) ?? [change.entityId]) {
      if (change.contaminated) {
        if (!since.has(id)) since.set(id, change.t);
      } else if (since.has(id)) {
        total.set(id, (total.get(id) ?? 0) + (change.t - (since.get(id) as number)));
        since.delete(id);
      }
    }
  }
  for (const [id, start] of since) total.set(id, (total.get(id) ?? 0) + Math.max(0, t - start));
  return total;
}

export function propagate(input: PropagationInput): PropagationResult {
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const entityOf = (id: string): Entity => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`propagate: unknown entity ${id}`);
    return e;
  };
  const handOf = (id: string): Entity => {
    const e = entityOf(id);
    if (!isHand(e)) throw new Error(`propagate: ${id} is not a hand`);
    return e;
  };

  const hands = new Map<string, MutableHand>();
  for (const e of input.entities) if (isHand(e)) hands.set(personOf(e), { contaminated: false, gloved: false, preGloveContaminated: false });
  const handState = (person: string): MutableHand => {
    const h = hands.get(person);
    if (h === undefined) throw new Error(`propagate: no hands for person ${person}`);
    return h;
  };
  const state = new Map<string, boolean>();
  for (const e of input.entities) if (!isHand(e) && e.class !== "dispenser") state.set(e.id, false);

  const changes: ContaminationChange[] = [];
  const transfers: TransferEdge[] = [];
  const exposures: ResidentExposure[] = [];
  const hops: Record<string, number> = {};
  const handKey = (person: string): string => `person:${person}`;

  // Source at t = 0.
  const source = entityOf(input.scenario.sourceEntityId);
  if (isHand(source)) {
    const p = personOf(source);
    handState(p).contaminated = true;
    hops[handKey(p)] = 0;
  } else {
    if (source.class === "dispenser") throw new Error("propagate: a dispenser cannot be the source");
    state.set(source.id, true);
    hops[source.id] = 0;
  }
  changes.push({ t: 0, entityId: source.id, contaminated: true, cause: "source" });

  const items: Item[] = [
    ...input.gloveEvents.map((event, index): Item => ({ t: event.t, order: 0, index, kind: "glove", event })),
    ...input.hygieneEvents.map((event, index): Item => ({ t: event.t, order: 1, index, kind: "hygiene", event })),
    ...input.contacts.map((event, index): Item => ({ t: event.startT, order: 2, index, kind: "contact", event })),
  ];
  items.sort((a, b) => a.t - b.t || a.order - b.order || a.index - b.index);

  for (const item of items) {
    if (item.kind === "glove") {
      const p = personOf(handOf(item.event.handId));
      const h = handState(p);
      if (item.event.type === "don") {
        h.preGloveContaminated = h.contaminated;
        h.gloved = true;
        if (h.contaminated) changes.push({ t: item.t, entityId: item.event.handId, contaminated: false, cause: "glove_don" });
        h.contaminated = false;
      } else {
        const after = DOFF_EXPOSES_BARE_HAND ? h.preGloveContaminated || h.contaminated : h.preGloveContaminated;
        if (after !== h.contaminated) changes.push({ t: item.t, entityId: item.event.handId, contaminated: after, cause: "glove_doff" });
        h.gloved = false;
        h.contaminated = after;
      }
      continue;
    }
    if (item.kind === "hygiene") {
      if (!item.event.effective) continue;
      const p = personOf(handOf(item.event.handId));
      const h = handState(p);
      if (h.contaminated) {
        h.contaminated = false;
        changes.push({ t: item.t, entityId: item.event.handId, contaminated: false, cause: "hygiene" });
      }
      continue;
    }
    // Contact.
    const hand = handOf(item.event.handId);
    const p = personOf(hand);
    const h = handState(p);
    const target = entityOf(item.event.entityId);
    if (target.class === "dispenser") throw new Error(`propagate: dispenser contact ${target.id} reached propagation; run splitHygiene first`);
    const targetContaminated = state.get(target.id) ?? false;
    const handWasContaminated = h.contaminated;

    if (handWasContaminated && target.class === "resident_zone") {
      exposures.push({ residentId: target.id, handId: hand.id, t: item.t });
    }
    if (handWasContaminated && !targetContaminated) {
      state.set(target.id, true);
      transfers.push({ fromId: hand.id, toId: target.id, t: item.t });
      changes.push({ t: item.t, entityId: target.id, contaminated: true, cause: "transfer" });
      hops[target.id] = (hops[handKey(p)] ?? 0) + 1;
    } else if (!handWasContaminated && targetContaminated) {
      h.contaminated = true;
      transfers.push({ fromId: target.id, toId: hand.id, t: item.t });
      changes.push({ t: item.t, entityId: hand.id, contaminated: true, cause: "transfer" });
      hops[handKey(p)] = (hops[target.id] ?? 0) + 1;
    }
  }

  const contaminated: string[] = [];
  for (const e of input.entities) {
    if (isHand(e)) {
      if (handState(personOf(e)).contaminated) contaminated.push(e.id);
    } else if (state.get(e.id) === true) {
      contaminated.push(e.id);
    }
  }
  const handsOut: Record<string, HandState> = {};
  for (const [p, h] of hands) handsOut[p] = { contaminated: h.contaminated, gloved: h.gloved };

  return { contaminated, hands: handsOut, transfers, residentExposures: exposures, changes, hops };
}
