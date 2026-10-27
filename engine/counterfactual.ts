// "If hands had been cleaned at t": insert one hygiene event, rerun propagation, moments, and
// score, and report the difference. Pure and instant because the engine is a pure function.

import type { ScoreWeights } from "./config.ts";
import { detectMomentMisses } from "./moments.ts";
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
  const inserted: HygieneEvent = {
    handId: insert.handId,
    t: insert.t,
    agent: insert.agent,
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
