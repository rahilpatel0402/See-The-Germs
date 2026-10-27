// Scenario and adjudication files for a clip. Separate from analysis.ts so pipeline.ts can
// import it without a cycle.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isPathogenId } from "../engine/pathogens.ts";
import type { Adjudication, Scenario } from "../engine/types.ts";
import { readEntities, type EntityConfig } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { adjudicationsPath, scenarioPath } from "./paths.ts";

export async function readAdjudications(clipId: string): Promise<Adjudication[]> {
  const file = adjudicationsPath(clipId);
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, "utf8")) as Adjudication[];
}

// Default: the first object in patient zone A as the source (else the first non-hand,
// non-dispenser entity) and MRSA.
export function defaultScenario(entities: readonly EntityConfig[]): Scenario | null {
  const source =
    entities.find((e) => e.class === "object" && e.zone === "patient_zone_A") ??
    entities.find((e) => e.class !== "bare_hand" && e.class !== "gloved_hand" && e.class !== "dispenser");
  return source ? { sourceEntityId: source.id, pathogen: "mrsa" } : null;
}

function isValidScenario(value: unknown, entityIds: ReadonlySet<string>): value is Scenario {
  const v = value as { sourceEntityId?: unknown; pathogen?: unknown } | null;
  return typeof v?.sourceEntityId === "string" && entityIds.has(v.sourceEntityId) && typeof v.pathogen === "string" && isPathogenId(v.pathogen);
}

// The stored scenario if it is still valid for the clip's entities, otherwise the default. A
// stored source that was renamed or removed in the entity editor must not brick the clip.
export async function readScenario(clipId: string): Promise<Scenario> {
  const entities = await readEntities(clipId);
  const ids = new Set(entities.map((e) => e.id));
  const file = scenarioPath(clipId);
  if (existsSync(file)) {
    const stored: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isValidScenario(stored, ids)) return stored;
  }
  const fallback = defaultScenario(entities);
  if (!fallback) throw new HttpError(409, `clip ${clipId} has no entity that can be a source`);
  return fallback;
}

export async function writeScenario(clipId: string, scenario: Scenario): Promise<void> {
  await writeFile(scenarioPath(clipId), JSON.stringify(scenario, null, 2));
}

// Strict validation for user input (400 on failure).
export function validateScenario(value: unknown, entityIds: ReadonlySet<string>): Scenario {
  const v = value as { sourceEntityId?: unknown; pathogen?: unknown };
  if (typeof v?.sourceEntityId !== "string" || !entityIds.has(v.sourceEntityId)) throw new HttpError(400, "sourceEntityId must name an entity in this clip");
  if (typeof v.pathogen !== "string" || !isPathogenId(v.pathogen)) throw new HttpError(400, "pathogen must be one of mrsa, c_auris, c_difficile, norovirus");
  return { sourceEntityId: v.sourceEntityId, pathogen: v.pathogen };
}
