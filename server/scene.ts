// Scene setup: Muse Spark looks at three frames and proposes the prop table with SAM phrases;
// SAM tests each phrase on a frame; anything SAM cannot find goes back to Spark once for new
// phrases. The result is an entities.json a person can still edit. Spark proposes, SAM verifies.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GLOVE_MIN_CONFIDENCE, SCENE_PHRASE_CONFIG } from "../engine/config.ts";
import { boxIoU } from "../engine/persistence.ts";
import { PROP_CLASSES, ZONE_TAGS, type DispenserAgent, type EntityClass, type MaskBounds, type MaskRecord, type ZoneTag } from "../engine/types.ts";
import { readMeta } from "./clips.ts";
import { type EntityConfig, readEntities, validateEntities, writeEntities } from "./entities.ts";
import { rawFramePath } from "./frames.ts";
import { clipDir, trackPath } from "./paths.ts";
import { isBoxPhrase, segmentImage } from "./sam.ts";
import { estimateSparkCost, type SparkBackend, type SparkRequest, type SparkResult } from "./spark.ts";

// Heuristic: two verified props whose found objects cover the same area of the test frame (same
// object count, union boxes overlapping at this IoU or more) are one prop named twice.
const DUPLICATE_IOU = 0.7;

const ZONES: readonly ZoneTag[] = ZONE_TAGS;
const KINDS: readonly EntityClass[] = PROP_CLASSES;
const AGENTS = ["alcohol_rub", "soap_water", "gloves", "none"] as const;
const MAX_PROPS = 10;

const SCENE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          kind: { type: "string", enum: KINDS },
          zone: { type: "string", enum: ZONES },
          agent: { type: "string", enum: AGENTS },
          aseptic: { type: "boolean" },
          phrases: { type: "array", items: { type: "string" } },
        },
        required: ["label", "kind", "zone", "agent", "aseptic", "phrases"],
      },
    },
  },
  required: ["entities"],
};

const RETRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { phrases: { type: "array", items: { type: "string" } } },
  required: ["phrases"],
};

interface Proposed {
  label: string;
  kind: EntityClass;
  zone: ZoneTag;
  agent: (typeof AGENTS)[number];
  aseptic: boolean;
  phrases: string[];
}

export interface PhraseTrial {
  readonly phrase: string;
  readonly objects: number;
  readonly meanConfidence: number | null;
}

export interface SceneEntityReport {
  readonly id: string;
  readonly label: string;
  readonly tried: readonly PhraseTrial[];
  readonly chosen: string | null;
  readonly verified: boolean;
  // Set when the prop was folded into an earlier one that SAM resolved to the same object.
  readonly mergedInto?: string;
  // A plain-language note about a change the loop made, for example a dispenser kept as a surface.
  readonly note?: string;
}

export interface SceneResult {
  readonly entities: readonly EntityConfig[];
  readonly report: readonly SceneEntityReport[];
  readonly frames: readonly number[];
  readonly cost: number;
}

// The one id rule for props created from a label, shared by the scene loop and the box tool.
export function slugId(label: string, used: Set<string>): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "prop";
  if (/^[0-9]/.test(base)) base = `p_${base}`;
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

function trial(phrase: string, records: readonly MaskRecord[]): PhraseTrial {
  const objects = new Set(records.map((r) => r.objectId)).size;
  const conf = records.map((r) => r.confidence).filter((c): c is number => c !== undefined);
  return { phrase, objects, meanConfidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null };
}

function good(t: PhraseTrial): boolean {
  return t.objects >= SCENE_PHRASE_CONFIG.minObjects && t.objects <= SCENE_PHRASE_CONFIG.maxObjects && (t.meanConfidence ?? 0) >= SCENE_PHRASE_CONFIG.minConfidence;
}

async function loadPrompt(): Promise<string> {
  return readFile(path.join(process.cwd(), "server", "prompts", "scene.md"), "utf8");
}

function shortHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

interface CachedSpark {
  readonly json: unknown;
  readonly usage: SparkResult["usage"];
  readonly elapsedMs: number;
  readonly model: string;
  readonly backend: string;
  readonly createdAt: string;
}

// Spark calls of the scene loop, cached under data/clips/<id>/scene/ by frames, prompt, text,
// and model. A repeated propose with nothing changed reads from disk and costs nothing.
async function cachedSpark(clipId: string, kind: string, frames: readonly number[], spark: SparkBackend, request: SparkRequest): Promise<{ result: SparkResult; cached: boolean }> {
  const dir = path.join(clipDir(clipId), "scene");
  const file = path.join(dir, `${kind}-${shortHash([frames, request.instructions, request.text, request.schemaName, spark.model])}.json`);
  if (existsSync(file)) {
    const hit = JSON.parse(await readFile(file, "utf8")) as CachedSpark;
    return { result: { json: hit.json, usage: hit.usage, elapsedMs: 0 }, cached: true };
  }
  const result = await spark.completeJson(request);
  await mkdir(dir, { recursive: true });
  const record: CachedSpark = { json: result.json, usage: result.usage, elapsedMs: result.elapsedMs, model: spark.model, backend: spark.name, createdAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(record, null, 2));
  return { result, cached: false };
}

// One SAM still-image phrase test, cached under data/clips/<id>/phrases/ by frame and phrase.
// The phrase picker script writes PNGs with the same stem, so the JSON sits next to them.
async function cachedPhraseTest(clipId: string, frameIndex: number, png: Buffer, phrase: string): Promise<{ records: MaskRecord[]; cached: boolean }> {
  const dir = path.join(clipDir(clipId), "phrases");
  const file = path.join(dir, `f${frameIndex}-${phrase.replace(/[^a-z0-9]+/gi, "_")}.json`);
  if (existsSync(file)) {
    const hit = JSON.parse(await readFile(file, "utf8")) as { phrase: string; records: MaskRecord[] };
    if (hit.phrase === phrase) return { records: hit.records, cached: true };
  }
  const { records, elapsedMs } = await segmentImage(png, phrase);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ phrase, frameIndex, records, elapsedMs, createdAt: new Date().toISOString() }, null, 2));
  return { records, cached: false };
}

function unionBox(records: readonly MaskRecord[]): MaskBounds | null {
  if (records.length === 0) return null;
  return records.reduce<MaskBounds>(
    (acc, r) => ({ left: Math.min(acc.left, r.bounds.left), top: Math.min(acc.top, r.bounds.top), right: Math.max(acc.right, r.bounds.right), bottom: Math.max(acc.bottom, r.bounds.bottom) }),
    { ...records[0]!.bounds },
  );
}

export async function proposeScene(clipId: string, spark: SparkBackend): Promise<SceneResult> {
  const meta = await readMeta(clipId);
  const last = Math.max(0, meta.sampled.frames - 1);
  const frames = [...new Set([0, Math.floor(last / 2), last])];
  const images: Buffer[] = [];
  for (const f of frames) images.push(await readFile(await rawFramePath(clipId, f)));
  const prompt = await loadPrompt();
  let cost = 0;

  const { result: proposal, cached: proposalCached } = await cachedSpark(clipId, "proposal", frames, spark, {
    instructions: prompt,
    text: `Three frames from a ${(meta.sampled.frames / meta.fps).toFixed(0)} second clip, in time order. List the props.`,
    images,
    schemaName: "scene",
    schema: SCENE_SCHEMA,
    maxOutputTokens: 8000,
  });
  if (!proposalCached) cost += estimateSparkCost(proposal.usage);
  console.log(`spark   | ${clipId} | scene proposal${proposalCached ? " (cached)" : ""} | in=${proposal.usage.inputTokens} out=${proposal.usage.outputTokens} (reasoning ${proposal.usage.reasoningTokens}) | ${proposal.elapsedMs} ms | $${proposalCached ? "0.0000" : estimateSparkCost(proposal.usage).toFixed(4)}`);
  const raw = (proposal.json as { entities?: unknown })?.entities;
  if (!Array.isArray(raw)) throw new Error("scene: Spark returned no entities");
  const proposed: Proposed[] = raw
    .filter((e): e is Proposed => typeof e?.label === "string" && e.label.trim().length > 0 && KINDS.includes(e.kind) && ZONES.includes(e.zone) && Array.isArray(e.phrases))
    .slice(0, MAX_PROPS)
    .map((e) => ({ ...e, label: e.label.trim(), phrases: e.phrases.filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()).slice(0, 3) }));

  // Keep what a person or the box tool already set up: hands (any person) and box-tracked
  // props, whose paid tracks must not be orphaned. Phrase-based props are replaced by the proposal.
  let existing: EntityConfig[] = [];
  try {
    existing = await readEntities(clipId);
  } catch {
    // no table yet
  }
  // Hands, box-tracked props, and any prop whose phrase already has a paid video track stay; a
  // cached track is stronger evidence than a still-frame test and costs nothing to keep.
  const kept = existing.filter((e) => e.class === "bare_hand" || e.class === "gloved_hand" || isBoxPhrase(e.samPhrase) || existsSync(trackPath(clipId, e.samPhrase)));
  if (!kept.some((e) => e.class === "bare_hand")) kept.unshift({ id: "bare_hand", label: "bare hand", class: "bare_hand", zone: "healthcare_area", samPhrase: "bare hand", person: "P1" });
  if (!kept.some((e) => e.class === "gloved_hand")) kept.splice(1, 0, { id: "gloved_hand", label: "gloved hand", class: "gloved_hand", zone: "healthcare_area", samPhrase: "gloved hand", person: "P1", minConfidence: GLOVE_MIN_CONFIDENCE });

  // Verify phrases on the middle frame with the SAM image endpoint.
  const testIndex = Math.min(1, frames.length - 1);
  const testFrame = images[testIndex] as Buffer;
  const testFrameIndex = frames[testIndex] as number;
  const used = new Set<string>(kept.map((e) => e.id));
  const entities: EntityConfig[] = [...kept];
  const report: SceneEntityReport[] = [];
  // Verified props so far, with where SAM found them, for the duplicate check.
  const found: Array<{ id: string; objects: number; box: MaskBounds }> = [];

  for (const p of proposed) {
    const id = slugId(p.label, used);
    const tried: PhraseTrial[] = [];
    let chosen: string | null = null;
    let chosenRecords: readonly MaskRecord[] = [];
    const tryPhrases = async (phrases: readonly string[]): Promise<void> => {
      for (const phrase of phrases) {
        if (chosen) return;
        const { records, cached } = await cachedPhraseTest(clipId, testFrameIndex, testFrame, phrase);
        if (!cached) cost += 0.0025;
        const t = trial(phrase, records);
        tried.push(t);
        console.log(`phrase  | ${clipId} | ${p.label.padEnd(20)} | ${phrase.padEnd(32)} | objects=${t.objects} conf=${t.meanConfidence?.toFixed(2) ?? "?"}${cached ? " (cached)" : ""}`);
        if (good(t)) {
          chosen = phrase;
          chosenRecords = records;
        }
      }
    };
    await tryPhrases(p.phrases);
    if (!chosen && p.phrases.length > 0) {
      // One more round: tell Spark what failed and ask for plainer descriptions.
      const { result: retry, cached: retryCached } = await cachedSpark(clipId, "retry", frames, spark, {
        instructions: prompt,
        text: `The prop "${p.label}" was not found by the segmentation model with these phrases: ${p.phrases.map((x) => `"${x}"`).join(", ")}. Look at the frames again and give three different, plainer phrases describing only its color, shape, and material.`,
        images,
        schemaName: "phrases",
        schema: RETRY_SCHEMA,
        maxOutputTokens: 4000,
      });
      if (!retryCached) cost += estimateSparkCost(retry.usage);
      const more = ((retry.json as { phrases?: unknown })?.phrases as unknown[] | undefined)?.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 3) ?? [];
      await tryPhrases(more);
    }

    // The same object named twice (tray, basket, instruments for one perforated basket) joins
    // the first prop instead of becoming a second entity with its own paid track.
    if (chosen) {
      const box = unionBox(chosenRecords);
      const objects = new Set(chosenRecords.map((r) => r.objectId)).size;
      const twin = box ? found.find((f) => f.objects === objects && boxIoU(f.box, box) >= DUPLICATE_IOU) : undefined;
      if (twin) {
        used.delete(id);
        report.push({ id, label: p.label, tried, chosen, verified: true, mergedInto: twin.id, note: `SAM found the same object as "${twin.id}"; kept as one prop.` });
        console.log(`scene   | ${clipId} | "${p.label}" resolves to the same object as ${twin.id}; merged`);
        continue;
      }
      if (box) found.push({ id, objects, box });
    }

    // A dispenser with no hygiene agent is a surface people touch, never a sanitizer: an LLM
    // proposal must not create hygiene events. It stays an object in its own zone.
    const dispenser = p.kind === "dispenser" && p.agent !== "none";
    const kind: EntityClass = p.kind === "dispenser" && !dispenser ? "object" : p.kind;
    const note = p.kind === "dispenser" && !dispenser ? "Proposed as a dispenser with no hygiene agent; kept as a surface. Change it in the table if it is a sanitizer or soap." : undefined;
    const entity: EntityConfig = {
      id,
      label: p.label,
      class: kind,
      zone: dispenser ? "hygiene_station" : p.zone,
      samPhrase: chosen ?? p.phrases[0] ?? p.label,
      ...(dispenser ? { agent: p.agent as DispenserAgent } : {}),
      ...(p.aseptic && kind === "object" ? { aseptic: true } : {}),
    };
    entities.push(entity);
    report.push({ id, label: p.label, tried, chosen, verified: chosen !== null, ...(note ? { note } : {}) });
  }

  validateEntities(entities);
  await writeEntities(clipId, entities);
  const result: SceneResult = { entities, report, frames, cost: Number(cost.toFixed(4)) };
  await writeFile(path.join(clipDir(clipId), "scene.json"), JSON.stringify(result, null, 2));
  console.log(`scene   | ${clipId} | ${report.length} props proposed, ${report.filter((r) => r.verified && !r.mergedInto).length} verified by SAM, ${report.filter((r) => r.mergedInto).length} merged, ${kept.length} kept from before, about $${result.cost.toFixed(3)}`);
  return result;
}
