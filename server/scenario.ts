// Scenario and adjudication files for a clip. Separate from analysis.ts so pipeline.ts can
// import it without a cycle.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isPathogenId } from "../engine/pathogens.ts";
import type { Adjudication, Entity, Scenario } from "../engine/types.ts";
import { readEntities, type EntityConfig } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { adjudicationsPath, scenarioPath } from "./paths.ts";

export async function readAdjudications(clipId: string): Promise<Adjudication[]> {
  const file = adjudicationsPath(clipId);
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, "utf8")) as Adjudication[];
}

// Anything but a dispenser can be the source: an object, a resident zone, or a hand.
export function canBeSource(entity: Pick<Entity, "class">): boolean {
  return entity.class !== "dispenser";
}

// Default: the first object in patient zone A as the source (else the first non-hand,
// non-dispenser entity) and MRSA.
export function defaultScenario(entities: readonly EntityConfig[]): Scenario | null {
  const source =
    entities.find((e) => e.class === "object" && e.zone === "patient_zone_A") ??
    entities.find((e) => e.class !== "bare_hand" && e.class !== "gloved_hand" && canBeSource(e));
  return source ? { sourceEntityId: source.id, pathogen: "mrsa" } : null;
}

function sourceReason(value: unknown, entities: ReadonlyMap<string, Pick<Entity, "class">>): string | null {
  const v = value as { sourceEntityId?: unknown; pathogen?: unknown } | null;
  if (typeof v?.sourceEntityId !== "string") return "sourceEntityId must name an entity in this clip";
  const entity = entities.get(v.sourceEntityId);
  if (!entity) return "sourceEntityId must name an entity in this clip";
  if (!canBeSource(entity)) return "a dispenser cannot be the source";
  if (typeof v.pathogen !== "string" || !isPathogenId(v.pathogen)) return "pathogen must be one of mrsa, c_auris, c_difficile, norovirus";
  return null;
}

function entityMap(entities: readonly Pick<Entity, "id" | "class">[]): Map<string, Pick<Entity, "class">> {
  return new Map(entities.map((e) => [e.id, e]));
}

// The stored scenario if it is still valid for the clip's entities, otherwise the default. A
// stored source that was renamed, removed, or turned into a dispenser must not brick the clip.
export async function readScenario(clipId: string): Promise<Scenario> {
  const entities = await readEntities(clipId);
  const file = scenarioPath(clipId);
  if (existsSync(file)) {
    const stored: unknown = JSON.parse(await readFile(file, "utf8"));
    if (sourceReason(stored, entityMap(entities)) === null) return stored as Scenario;
  }
  const fallback = defaultScenario(entities);
  if (!fallback) throw new HttpError(409, `clip ${clipId} has no entity that can be a source`);
  return fallback;
}

export async function writeScenario(clipId: string, scenario: Scenario): Promise<void> {
  await writeFile(scenarioPath(clipId), JSON.stringify(scenario, null, 2));
}

// Strict validation for user input (400 on failure).
export function validateScenario(value: unknown, entities: readonly Pick<Entity, "id" | "class">[]): Scenario {
  const reason = sourceReason(value, entityMap(entities));
  if (reason) throw new HttpError(400, reason);
  const v = value as { sourceEntityId: string; pathogen: Scenario["pathogen"] };
  return { sourceEntityId: v.sourceEntityId, pathogen: v.pathogen };
}
