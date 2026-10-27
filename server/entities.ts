// Per-clip entity table: which SAM phrase to ask for, what to call it, which zone it is in.
// Stored at data/clips/<id>/entities.json and editable before segmentation.
import { readFile, writeFile } from "node:fs/promises";
import type { Entity } from "../engine/types.ts";
import { entitiesPath } from "./paths.ts";

export interface EntityConfig extends Entity {
  // Records below this SAM confidence are dropped when tracks are loaded. Used for the gloved
  // hand class, which fired at low confidence on bare skin in the feasibility clip.
  readonly minConfidence?: number;
}

// Defaults for the clip A scenario with household props (docs/DEV_CLIP_SHOOT.md). Phrases
// describe appearance, not function; edit them per clip.
export const DEFAULT_ENTITIES: readonly EntityConfig[] = [
  { id: "bare_hand", label: "bare hand", class: "bare_hand", zone: "healthcare_area", samPhrase: "bare hand" },
  { id: "gloved_hand", label: "gloved hand", class: "gloved_hand", zone: "healthcare_area", samPhrase: "gloved hand", minConfidence: 0.85 },
  { id: "rail_A", label: "bed rail A", class: "object", zone: "patient_zone_A", samPhrase: "white rod" },
  { id: "iv_pole", label: "IV pole", class: "object", zone: "healthcare_area", samPhrase: "floor lamp" },
  { id: "phone", label: "phone", class: "object", zone: "healthcare_area", samPhrase: "phone" },
  { id: "blanket_B", label: "blanket B", class: "object", zone: "patient_zone_B", samPhrase: "blanket" },
  { id: "resident_B", label: "resident B", class: "resident_zone", zone: "patient_zone_B", samPhrase: "pillow" },
  { id: "sanitizer", label: "sanitizer dispenser", class: "dispenser", zone: "hygiene_station", samPhrase: "pump bottle" },
  { id: "glove_box", label: "glove box", class: "dispenser", zone: "hygiene_station", samPhrase: "tissue box" },
];

export async function readEntities(clipId: string): Promise<EntityConfig[]> {
  const raw = await readFile(entitiesPath(clipId), "utf8");
  return JSON.parse(raw) as EntityConfig[];
}

export async function writeEntities(clipId: string, entities: readonly EntityConfig[]): Promise<void> {
  validateEntities(entities);
  await writeFile(entitiesPath(clipId), JSON.stringify(entities, null, 2));
}

const CLASSES = new Set(["bare_hand", "gloved_hand", "object", "resident_zone", "dispenser"]);
const ZONES = new Set(["patient_zone_A", "patient_zone_B", "healthcare_area", "hygiene_station"]);

export function validateEntities(entities: unknown): asserts entities is EntityConfig[] {
  if (!Array.isArray(entities) || entities.length === 0) throw new Error("entities must be a non-empty array");
  const ids = new Set<string>();
  for (const e of entities as Array<Record<string, unknown>>) {
    if (typeof e["id"] !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(e["id"])) throw new Error("entity id must be a short slug");
    if (ids.has(e["id"])) throw new Error(`duplicate entity id ${e["id"]}`);
    ids.add(e["id"]);
    if (typeof e["label"] !== "string" || !e["label"]) throw new Error(`entity ${e["id"]} needs a label`);
    if (!CLASSES.has(String(e["class"]))) throw new Error(`entity ${e["id"]} has an unknown class`);
    if (!ZONES.has(String(e["zone"]))) throw new Error(`entity ${e["id"]} has an unknown zone`);
    if (typeof e["samPhrase"] !== "string" || !e["samPhrase"].trim()) throw new Error(`entity ${e["id"]} needs a samPhrase`);
    if (e["minConfidence"] !== undefined && (typeof e["minConfidence"] !== "number" || e["minConfidence"] < 0 || e["minConfidence"] > 1)) {
      throw new Error(`entity ${e["id"]} minConfidence must be 0 to 1`);
    }
  }
}
