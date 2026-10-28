// npm run spark-compare -- <clipId> [backendA] [backendB]
// Runs the same narrative and the same cached adjudication frames through two Spark backends
// (default meta and fireworks) and writes data/clips/<id>/spark-compare.json. This is the
// evidence that the project runs end to end on Muse Spark Open through partner inference.
import "../env.ts";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAnalysis } from "../analysis.ts";
import { narrateClip } from "../narrate.ts";
import { clipDir } from "../paths.ts";
import { readAdjudications } from "../scenario.ts";
import { createSparkBackend, estimateSparkCost, type SparkBackend } from "../spark.ts";

const clipId = process.argv[2];
const a = process.argv[3] ?? "meta";
const b = process.argv[4] ?? "fireworks";
if (!clipId) {
  console.error("usage: npm run spark-compare -- <clipId> [backendA] [backendB]");
  process.exit(2);
}
const id: string = clipId;

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { verdict: { type: "string", enum: ["touching", "passing_in_front", "unclear"] }, reasoning: { type: "string" } },
  required: ["verdict", "reasoning"],
};

const analysis = await runAnalysis(id);
const labels = new Map(analysis.entities.map((e) => [e.id, e.label]));
const adjudicatePrompt = await readFile(path.join(process.cwd(), "server", "prompts", "adjudicate.md"), "utf8");
const cachedVerdicts = await readAdjudications(id);

interface BackendReport {
  backend: string;
  model: string;
  narrative: { top_fix: string; coaching_note: string; audit_summary: string; usage: unknown; elapsedMs?: number };
  adjudications: Array<{ candidateId: string; verdict: string; reasoning: string; usage: unknown; elapsedMs: number; cost: number }>;
}

async function run(name: string): Promise<BackendReport> {
  const backend: SparkBackend = createSparkBackend(name);
  console.log(`\n=== ${backend.name} (${backend.model}) ===`);
  const started = Date.now();
  const file = await narrateClip(id, analysis, backend);
  console.log(`narrative: ${file.narrative.top_fix}`);
  const adjudications: BackendReport["adjudications"] = [];
  for (const cached of cachedVerdicts) {
    const safe = cached.candidateId.replace(/[^A-Za-z0-9_-]/g, "_");
    const files = [1, 2].map((n) => path.join(clipDir(id), "adjudication", `${safe}-${n}.png`));
    if (!files.every((f) => existsSync(f))) continue;
    const images = await Promise.all(files.map((f) => readFile(f)));
    const [, entityId] = cached.candidateId.split(":");
    const text = `Object: ${labels.get(entityId ?? "") ?? entityId}. Image 1 is the first frame of the moment, image 2 is the middle frame. Is the hand touching the object?`;
    try {
      const result = await backend.completeJson({ instructions: adjudicatePrompt, text, images, schemaName: "adjudication", schema: VERDICT_SCHEMA, maxOutputTokens: 1500 });
      const v = result.json as { verdict?: string; reasoning?: string };
      console.log(`adjudicate ${cached.candidateId}: ${v.verdict} (cached meta verdict: ${cached.verdict}) | ${result.elapsedMs} ms`);
      adjudications.push({ candidateId: cached.candidateId, verdict: v.verdict ?? "invalid", reasoning: v.reasoning ?? "", usage: result.usage, elapsedMs: result.elapsedMs, cost: estimateSparkCost(result.usage) });
    } catch (err) {
      console.log(`adjudicate ${cached.candidateId}: FAILED ${(err as Error).message}`);
      adjudications.push({ candidateId: cached.candidateId, verdict: "failed", reasoning: (err as Error).message, usage: null, elapsedMs: 0, cost: 0 });
    }
  }
  return { backend: backend.name, model: backend.model, narrative: { ...file.narrative, usage: file.usage, elapsedMs: Date.now() - started }, adjudications };
}

const reports = [await run(a), await run(b)];
const agree = reports[0]!.adjudications.filter((x) => reports[1]!.adjudications.find((y) => y.candidateId === x.candidateId)?.verdict === x.verdict).length;
const out = { id, generatedAt: new Date().toISOString(), reports, adjudicationAgreement: `${agree} of ${reports[0]!.adjudications.length}` };
await writeFile(path.join(clipDir(id), "spark-compare.json"), JSON.stringify(out, null, 2));
console.log(`\nadjudication agreement between ${a} and ${b}: ${out.adjudicationAgreement}`);
console.log(`written to data/clips/${id}/spark-compare.json`);
