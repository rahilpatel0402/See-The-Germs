// Vision adjudication of ambiguous contact candidates. SAM finds, Spark adjudicates, the
// engine decides. Verdicts are cached in adjudications.json and never re-asked. A call that
// fails is not cached, so a transient outage never becomes a permanent "verdict".
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { framesFor, planAdjudication, type AdjudicationPlan } from "../engine/adjudication.ts";
import { ADJUDICATION_CONFIG } from "../engine/config.ts";
import type { Adjudication, ContactCandidate, MaskRecord, Verdict } from "../engine/types.ts";
import { passesConfidence, type EntityConfig } from "./entities.ts";
import { readAdjudications } from "./scenario.ts";
import { HttpError } from "./errors.ts";
import { renderAnnotatedFrame, type Outline } from "./frames.ts";
import { adjudicationsPath, clipDir } from "./paths.ts";
import { perceptionFor } from "./pipeline.ts";
import { readTrack } from "./sam.ts";
import { estimateSparkCost, type SparkBackend } from "./spark.ts";

const VERDICTS: readonly Verdict[] = ["touching", "passing_in_front", "unclear"];
const HAND_COLOR = "#00e5ff";
const OBJECT_COLOR = "#ff00c8";
const MAX_OUTPUT_TOKENS = 1500;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    reasoning: { type: "string" },
  },
  required: ["verdict", "reasoning"],
};

export interface AdjudicationFailure {
  readonly candidateId: string;
  readonly reason: string;
}

export interface AdjudicationRun {
  readonly plan: AdjudicationPlan;
  readonly added: readonly Adjudication[];
  readonly failed: readonly AdjudicationFailure[];
  readonly all: readonly Adjudication[];
}

async function loadPrompt(): Promise<string> {
  return readFile(path.join(process.cwd(), "server", "prompts", "adjudicate.md"), "utf8");
}

function parseVerdict(json: unknown): Omit<Adjudication, "candidateId"> | null {
  const v = json as { verdict?: unknown; reasoning?: unknown };
  if (typeof v?.verdict !== "string" || !(VERDICTS as readonly string[]).includes(v.verdict)) return null;
  if (typeof v.reasoning !== "string") return null;
  return { verdict: v.verdict as Verdict, reasoning: v.reasoning.trim().slice(0, 400) };
}

// Records of one entity at one frame, with the same confidence rule as the engine input.
async function recordsAt(clipId: string, entity: EntityConfig, frameIndex: number): Promise<MaskRecord[]> {
  const track = await readTrack(clipId, entity.samPhrase);
  if (!track) throw new HttpError(409, `clip ${clipId} has no track for "${entity.samPhrase}"`);
  return track.records.filter((r) => r.frameIndex === frameIndex && passesConfidence(entity, r));
}

export async function adjudicateClip(clipId: string, backend: SparkBackend, options: { force?: readonly string[] } = {}): Promise<AdjudicationRun> {
  const perception = await perceptionFor(clipId);
  const candidates = perception.candidates;
  const existing = await readAdjudications(clipId);
  const plan = planAdjudication(candidates, existing, ADJUDICATION_CONFIG);

  // Forced candidates (dev script only) are asked regardless of band and cap. The engine still
  // only applies verdicts to ambiguous candidates, so forcing a confident one changes nothing.
  const done = new Set(existing.map((a) => a.candidateId));
  const forced = (options.force ?? [])
    .map((id) => candidates.find((c) => c.id === id))
    .filter((c): c is ContactCandidate => c !== undefined && !done.has(c.id) && !plan.selected.some((s) => s.id === c.id));
  const queue = [...plan.selected, ...forced];

  const byId = new Map(perception.entityConfigs.map((e) => [e.id, e]));
  const prompt = await loadPrompt();
  const outDir = path.join(clipDir(clipId), "adjudication");
  await mkdir(outDir, { recursive: true });
  const all = [...existing];
  const added: Adjudication[] = [];
  const failed: AdjudicationFailure[] = [];

  for (const candidate of queue) {
    const hand = byId.get(candidate.handId);
    const object = byId.get(candidate.entityId);
    if (!hand || !object) throw new Error(`adjudicate: unknown entity on candidate ${candidate.id}`);
    const frames = plan.frames[candidate.id] ?? framesFor(candidate);
    const images: Buffer[] = [];
    for (const [n, frameIndex] of [frames.first, frames.middle].entries()) {
      const outlines: Outline[] = [
        { records: await recordsAt(clipId, hand, frameIndex), color: HAND_COLOR },
        { records: await recordsAt(clipId, object, frameIndex), color: OBJECT_COLOR },
      ];
      const png = await renderAnnotatedFrame(clipId, frameIndex, outlines);
      await writeFile(path.join(outDir, `${candidate.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${n + 1}.png`), png);
      images.push(png);
    }

    const text = `Object: ${object.label}. Image 1 is the first frame of the moment, image 2 is the middle frame. Is the hand touching the object?`;
    let adjudication: Adjudication | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && adjudication === null; attempt++) {
      try {
        const result = await backend.completeJson({ instructions: prompt, text, images, schemaName: "adjudication", schema: SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS });
        const parsed = parseVerdict(result.json);
        console.log(
          `spark   | ${clipId} | adjudicate ${candidate.id.padEnd(28)} | ${parsed ? parsed.verdict.padEnd(16) : "INVALID JSON    "} | in=${result.usage.inputTokens} (cached ${result.usage.cachedTokens}) out=${result.usage.outputTokens} (reasoning ${result.usage.reasoningTokens}) | ${String(result.elapsedMs).padStart(5)} ms | $${estimateSparkCost(result.usage).toFixed(4)}`,
        );
        if (parsed) adjudication = { candidateId: candidate.id, ...parsed };
        else lastError = `invalid verdict: ${JSON.stringify(result.json).slice(0, 120)}`;
      } catch (err) {
        lastError = (err as Error).message;
        console.log(`spark   | ${clipId} | adjudicate ${candidate.id} | attempt ${attempt + 1} failed: ${lastError}`);
      }
    }
    if (adjudication === null) {
      // Not cached: the candidate stays unreviewed and is planned again next run. Until then
      // the engine treats it as an ambiguous candidate without a verdict, which is not a contact.
      failed.push({ candidateId: candidate.id, reason: lastError });
      continue;
    }
    all.push(adjudication);
    added.push(adjudication);
    await writeFile(adjudicationsPath(clipId), JSON.stringify(all, null, 2));
  }

  if (!existsSync(adjudicationsPath(clipId))) await writeFile(adjudicationsPath(clipId), "[]");
  return { plan, added, failed, all };
}
