// "If hands had been cleaned at t": insert one hygiene event, rerun propagation, moments, and
// score, and report the difference. Pure and instant because the engine is a pure function.

import type { ScoreWeights } from "./config.ts";
import { detectMomentMisses } from "./moments.ts";
// detectMomentMisses stays the entry point here: the counterfactual reports misses, and the
// compliance view is recomputed by the caller when it needs opportunities.
import { agentClearsHands } from "./pathogens.ts";
import { propagate, type PropagationInput } from "./propagation.ts";
import { scoreExposure } from "./score.ts";
import type { Counterfactual, ExposureScore, HygieneAgent, HygieneEvent, PropagationResult } from "./types.ts";

export interface CounterfactualInsert {
  readonly handId: string;
  readonly t: number;
  readonly agent: HygieneAgent;
}

export interface CounterfactualBase {
  readonly propagation: PropagationResult;
  readonly score: ExposureScore;
}

const byT = (a: HygieneEvent, b: HygieneEvent): number => a.t - b.t;

export function runCounterfactual(
  input: PropagationInput,
  base: CounterfactualBase,
  insert: CounterfactualInsert,
  weights: ScoreWeights,
): Counterfactual {
  if (!(insert.t >= 0)) throw new Error(`runCounterfactual: t must be non-negative, got ${insert.t}`);
  // The inserted event is a proper rub by definition; only the agent's effectiveness is in question.
  const inserted: HygieneEvent = {
    handId: insert.handId,
    t: insert.t,
    agent: insert.agent,
    durationS: Number.POSITIVE_INFINITY,
    adequate: true,
    effective: agentClearsHands(input.profile, insert.agent),
  };
  const hygieneEvents = [...input.hygieneEvents, inserted].sort(byT);
  const withInsert: PropagationInput = { ...input, hygieneEvents };
  const propagation = propagate(withInsert);
  const momentMisses = detectMomentMisses(
    { contacts: withInsert.contacts, hygieneEvents, entities: withInsert.entities },
    propagation,
    (extra) => propagate({ ...withInsert, hygieneEvents: [...hygieneEvents, extra].sort(byT) }),
  );
  const after = scoreExposure(propagation, momentMisses, withInsert.entities, withInsert.scenario.sourceEntityId, weights);
  const afterSet = new Set(propagation.contaminated);
  const keptClean = base.propagation.contaminated.filter((id) => !afterSet.has(id));
  return { inserted, before: base.score, after, keptClean, propagation, momentMisses };
}
