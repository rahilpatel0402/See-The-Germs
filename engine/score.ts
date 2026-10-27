// Exposure score per PLAN.md 6.6. A heuristic number so the counterfactual has a before and after.

import type { ScoreWeights } from "./config.ts";
import type { Entity, ExposureScore, MomentMiss, PropagationResult } from "./types.ts";

export function scoreExposure(
  propagation: PropagationResult,
  misses: readonly MomentMiss[],
  entities: readonly Entity[],
  sourceEntityId: string,
  weights: ScoreWeights,
): ExposureScore {
  const byId = new Map(entities.map((e) => [e.id, e]));
  // The source is the premise of the scenario, not a consequence, so it is not counted.
  const contaminatedSurfaces = propagation.contaminated.filter((id) => id !== sourceEntityId && byId.get(id)?.class === "object").length;

  // Chain length counts transfer edges, the narrative "rail -> hand -> IV pole -> phone" in
  // PLAN.md 3. Every transfer descends from the source by construction. Graph hops are kept in
  // propagation.hops for the chain graph view, where one hand touching five things is depth 2.
  const chainLength = propagation.transfers.length;

  const residentExposures: Record<string, number> = {};
  for (const x of propagation.residentExposures) residentExposures[x.residentId] = (residentExposures[x.residentId] ?? 0) + 1;
  const totalExposures = propagation.residentExposures.length;

  const momentsMissed = { "1": 0, "2": 0, "4": 0, "5": 0 };
  for (const m of misses) momentsMissed[String(m.moment) as "1" | "2" | "4" | "5"]++;

  const score = weights.residentExposure * totalExposures + weights.contaminatedSurface * contaminatedSurfaces + weights.momentMiss * misses.length;
  return { contaminatedSurfaces, chainLength, residentExposures, momentsMissed, score };
}
