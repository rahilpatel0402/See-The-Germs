// Vision adjudication of ambiguous contact candidates. SAM finds, Spark adjudicates, the
// engine decides. Verdicts are cached in adjudications.json and never re-asked.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { planAdjudication, type AdjudicationPlan } from "../engine/adjudication.ts";
import { ADJUDICATION_CONFIG, CONTACT_CONFIG } from "../engine/config.ts";
import { detectContacts } from "../engine/contacts.ts";
import type { Adjudication, ContactCandidate, MaskRecord, Verdict } from "../engine/types.ts";
import { readAdjudications } from "./analysis.ts";
import { HttpError } from "./errors.ts";
import { renderAnnotatedFrame, type Outline } from "./frames.ts";
import { adjudicationsPath, clipDir } from "./paths.ts";
import { readTrack } from "./sam.ts";
import { estimateSparkCost, type SparkBackend } from "./spark.ts";
import { loadTracks } from "./tracks.ts";

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

export interface AdjudicationRun {
  readonly plan: AdjudicationPlan;
  readonly added: readonly Adjudication[];
  readonly all: readonly Adjudication[];
}

async function loadPrompt(): Promise<string> {
  return readFile(path.join(process.cwd(), "server", "prompts", "adjudicate.md"), "utf8");
}

function parseVerdict(json: unknown): Adjudication | null {
  const v = json as { verdict?: unknown; reasoning?: unknown };
  if (typeof v?.verdict !== "string" || !(VERDICTS as readonly string[]).includes(v.verdict)) return null;
  if (typeof v.reasoning !== "string") return null;
  return { candidateId: "", verdict: v.verdict as Verdict, reasoning: v.reasoning.trim().slice(0, 400) };
}

// Records of one entity at one frame, honoring the entity's minConfidence.
async function recordsAt(clipId: string, samPhrase: string, minConfidence: number | undefined, frameIndex: number): Promise<MaskRecord[]> {
  const track = await readTrack(clipId, samPhrase);
  if (!track) throw new HttpError(409, `clip ${clipId} has no track for "${samPhrase}"`);
  return track.records.filter(
    (r) => r.frameIndex === frameIndex && (minConfidence === undefined || r.confidence === undefined || r.confidence >= minConfidence),
  );
}

export async function adjudicateClip(clipId: string, backend: SparkBackend, options: { force?: readonly string[] } = {}): Promise<AdjudicationRun> {
  const { tracks, entities, missingPhrases } = await loadTracks(clipId);
  if (missingPhrases.length > 0) throw new HttpError(409, `clip ${clipId} is not segmented for: ${missingPhrases.join(", ")}`);
  const candidates = detectContacts(tracks, CONTACT_CONFIG);
  const existing = await readAdjudications(clipId);
  const plan = planAdjudication(candidates, existing, ADJUDICATION_CONFIG);

  // Forced candidates (dev script only) are asked regardless of band and cap. The engine still
  // only applies verdicts to ambiguous candidates, so forcing a confident one changes nothing.
  const done = new Set(existing.map((a) => a.candidateId));
  const forced = (options.force ?? [])
    .map((id) => candidates.find((c) => c.id === id))
    .filter((c): c is ContactCandidate => c !== undefined && !done.has(c.id) && !plan.selected.some((s) => s.id === c.id));
  const queue = [...plan.selected, ...forced];

  const byId = new Map(entities.map((e) => [e.id, e]));
  const prompt = await loadPrompt();
  const outDir = path.join(clipDir(clipId), "adjudication");
  await mkdir(outDir, { recursive: true });
  const all = [...existing];
  const added: Adjudication[] = [];

  for (const candidate of queue) {
    const hand = byId.get(candidate.handId);
    const object = byId.get(candidate.entityId);
    if (!hand || !object) throw new Error(`adjudicate: unknown entity on candidate ${candidate.id}`);
    const frames = plan.frames[candidate.id] ?? { first: candidate.startFrame, middle: Math.floor((candidate.startFrame + candidate.endFrame) / 2) };
    const images: Buffer[] = [];
    for (const [n, frameIndex] of [frames.first, frames.middle].entries()) {
      const outlines: Outline[] = [
        { records: await recordsAt(clipId, hand.samPhrase, hand.minConfidence, frameIndex), color: HAND_COLOR },
        { records: await recordsAt(clipId, object.samPhrase, object.minConfidence, frameIndex), color: OBJECT_COLOR },
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
        if (parsed) adjudication = { ...parsed, candidateId: candidate.id };
        else lastError = `invalid verdict: ${JSON.stringify(result.json).slice(0, 120)}`;
      } catch (err) {
        lastError = (err as Error).message;
        console.log(`spark   | ${clipId} | adjudicate ${candidate.id} | attempt ${attempt + 1} failed: ${lastError}`);
      }
    }
    if (adjudication === null) {
      // Fail toward caution for an infection control tool: keep the candidate as a contact and
      // say plainly that the model did not decide.
      adjudication = { candidateId: candidate.id, verdict: "unclear", reasoning: `model unavailable: ${lastError}` };
    }
    all.push(adjudication);
    added.push(adjudication);
    await writeFile(adjudicationsPath(clipId), JSON.stringify(all, null, 2));
  }

  if (!existsSync(adjudicationsPath(clipId))) await writeFile(adjudicationsPath(clipId), "[]");
  return { plan, added, all };
}
