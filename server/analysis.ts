// The analysis writer and the counterfactual runner. The engine work lives in pipeline.ts.
import { writeFile } from "node:fs/promises";
import { SCORE_WEIGHTS } from "../engine/config.ts";
import { runCounterfactual, type CounterfactualInsert } from "../engine/counterfactual.ts";
import type { Analysis, Counterfactual } from "../engine/types.ts";
import { HttpError } from "./errors.ts";
import { analysisPath } from "./paths.ts";
import { buildPipeline, hasOverride, type Pipeline, type ScenarioOverride } from "./pipeline.ts";

export { readAdjudications, readScenario, validateScenario, writeScenario } from "./scenario.ts";

// Writes analysis.json only for the stored scenario. Overrides are per run and never persisted,
// so a reload always shows the stored scenario and the cached file never lies.
export async function runAnalysis(clipId: string, override: ScenarioOverride = {}): Promise<Analysis> {
  const { analysis } = await buildPipeline(clipId, override);
  if (!hasOverride(override)) await writeFile(analysisPath(clipId), JSON.stringify(analysis, null, 2));
  return analysis;
}

export async function runCounterfactualFor(
  clipId: string,
  insert: { t: number; handId?: string; agent?: string },
  override: ScenarioOverride = {},
  prebuilt?: Pipeline,
): Promise<Counterfactual> {
  const { analysis, propInput } = prebuilt ?? (await buildPipeline(clipId, override));
  const hands = analysis.entities.filter((e) => e.class === "bare_hand" || e.class === "gloved_hand");
  const handId = insert.handId ?? hands[0]?.id;
  if (!handId || !hands.some((h) => h.id === handId)) throw new HttpError(400, "handId must name a hand entity in this clip");
  const agent = insert.agent ?? "soap_water";
  if (agent !== "soap_water" && agent !== "alcohol_rub") throw new HttpError(400, "agent must be soap_water or alcohol_rub");
  if (!Number.isFinite(insert.t) || insert.t < 0) throw new HttpError(400, "t must be a non-negative number of seconds");
  const request: CounterfactualInsert = { handId, t: insert.t, agent };
  return runCounterfactual(propInput, { propagation: analysis.propagation, score: analysis.score }, request, SCORE_WEIGHTS);
}
