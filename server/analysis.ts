// Scenario storage, adjudication cache reads, and the analysis writer. The engine work itself
// lives in pipeline.ts so analysis and counterfactual share one code path.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { SCORE_WEIGHTS } from "../engine/config.ts";
import { runCounterfactual, type CounterfactualInsert } from "../engine/counterfactual.ts";
import { isPathogenId } from "../engine/pathogens.ts";
import type { Adjudication, Analysis, Counterfactual, Scenario } from "../engine/types.ts";
import { readEntities } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { adjudicationsPath, analysisPath, scenarioPath } from "./paths.ts";

export async function readAdjudications(clipId: string): Promise<Adjudication[]> {
  const file = adjudicationsPath(clipId);
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, "utf8")) as Adjudication[];
}

// The clip's stored scenario, or a default: the first object in patient zone A as the source
// (else the first non-hand entity) and MRSA.
export async function readScenario(clipId: string): Promise<Scenario> {
  const file = scenarioPath(clipId);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as Scenario;
  const entities = await readEntities(clipId);
  const source =
    entities.find((e) => e.class === "object" && e.zone === "patient_zone_A") ??
    entities.find((e) => e.class !== "bare_hand" && e.class !== "gloved_hand" && e.class !== "dispenser");
  if (!source) throw new HttpError(409, `clip ${clipId} has no entity that can be a source`);
  return { sourceEntityId: source.id, pathogen: "mrsa" };
}

export async function writeScenario(clipId: string, scenario: Scenario): Promise<void> {
  await writeFile(scenarioPath(clipId), JSON.stringify(scenario, null, 2));
}

export function validateScenario(value: unknown, entityIds: ReadonlySet<string>): Scenario {
  const v = value as { sourceEntityId?: unknown; pathogen?: unknown };
  if (typeof v?.sourceEntityId !== "string" || !entityIds.has(v.sourceEntityId)) throw new HttpError(400, "sourceEntityId must name an entity in this clip");
  if (typeof v.pathogen !== "string" || !isPathogenId(v.pathogen)) throw new HttpError(400, "pathogen must be one of mrsa, c_auris, c_difficile, norovirus");
  return { sourceEntityId: v.sourceEntityId, pathogen: v.pathogen };
}

// Writes analysis.json only for the stored scenario. Overrides are per run and never persisted,
// so a reload always shows the stored scenario and the cached file never lies.
export async function runAnalysis(clipId: string, override?: { pathogen?: Scenario["pathogen"]; sourceEntityId?: string }): Promise<Analysis> {
  const { buildPipeline, hasOverride } = await import("./pipeline.ts");
  const { analysis } = await buildPipeline(clipId, override ?? {});
  if (!hasOverride(override ?? {})) await writeFile(analysisPath(clipId), JSON.stringify(analysis, null, 2));
  return analysis;
}

export async function runCounterfactualFor(
  clipId: string,
  insert: { t: number; handId?: string; agent?: string },
  override?: { pathogen?: Scenario["pathogen"]; sourceEntityId?: string },
  prebuilt?: { analysis: Analysis; propInput: import("../engine/propagation.ts").PropagationInput },
): Promise<Counterfactual> {
  const { buildPipeline } = await import("./pipeline.ts");
  const { analysis, propInput } = prebuilt ?? (await buildPipeline(clipId, override ?? {}));
  const hands = analysis.entities.filter((e) => e.class === "bare_hand" || e.class === "gloved_hand");
  const handId = insert.handId ?? hands[0]?.id;
  if (!handId || !hands.some((h) => h.id === handId)) throw new HttpError(400, "handId must name a hand entity in this clip");
  const agent = insert.agent ?? "soap_water";
  if (agent !== "soap_water" && agent !== "alcohol_rub") throw new HttpError(400, "agent must be soap_water or alcohol_rub");
  if (!Number.isFinite(insert.t) || insert.t < 0) throw new HttpError(400, "t must be a non-negative number of seconds");
  const request: CounterfactualInsert = { handId, t: insert.t, agent };
  return runCounterfactual(propInput, { propagation: analysis.propagation, score: analysis.score }, request, SCORE_WEIGHTS);
}
