// Muse Spark text: structured analysis in, coaching note and audit summary out. Validated,
// retried once, cached by a hash of the input so the same analysis never calls Spark twice.
// The model explains; it never produces, edits, or overrides contacts, transfers, moments, or scores.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Analysis, Counterfactual, Narrative } from "../engine/types.ts";
import { clipDir } from "./paths.ts";
import { estimateSparkCost, type SparkBackend, type SparkUsage } from "./spark.ts";

const NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    coaching_note: { type: "string" },
    audit_summary: { type: "string" },
    top_fix: { type: "string" },
  },
  required: ["coaching_note", "audit_summary", "top_fix"],
};

const EXPLAIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { counterfactual_explanation: { type: "string" } },
  required: ["counterfactual_explanation"],
};

// Word count bounds from PLAN.md 7 with 15 percent slack, because a model that lands on 117
// words has still done the job.
const COACHING_WORDS: readonly [number, number] = [100, 210];
const AUDIT_WORDS: readonly [number, number] = [85, 175];
const TOP_FIX_WORDS = 45;

// Anything that reads as patient-facing or clinical advice fails validation.
const DISALLOWED = /\b(diagnos\w*|prescri\w*|dosage|medication|antibiotic\w*|treat(ment)? plan|see a doctor|should be (treated|tested|isolated)|the (resident|patient) (should|needs|must))\b/i;

export interface NarrativeFile {
  readonly hash: string;
  readonly model: string;
  readonly backend: string;
  readonly createdAt: string;
  readonly usage: SparkUsage;
  readonly narrative: Narrative;
}

export function narrativePath(clipId: string): string {
  return path.join(clipDir(clipId), "narrative.json");
}

// The subset of the analysis Spark gets: labels instead of ids, no masks, no candidates.
export function trimForNarrative(analysis: Analysis): object {
  const label = new Map(analysis.entities.map((e) => [e.id, e.label]));
  const name = (id: string): string => label.get(id) ?? id;
  return {
    pathogen: {
      label: analysis.pathogen.label,
      note: analysis.pathogen.uiNote,
      alcohol_rub_clears_hands: analysis.pathogen.alcoholRubClearsHands,
      soap_and_water_clears_hands: analysis.pathogen.soapWaterClearsHands,
    },
    scenario: { source: name(analysis.scenario.sourceEntityId) },
    entities: analysis.entities.map((e) => ({ label: e.label, kind: e.class, zone: e.zone })),
    contacts: analysis.contacts.map((c) => ({ hand: name(c.handId), touched: name(c.entityId), start_s: c.startT, end_s: c.endT, vision_reviewed: c.adjudicated })),
    transfers: analysis.propagation.transfers.map((t) => ({ from: name(t.fromId), to: name(t.toId), at_s: t.t })),
    hygiene_events: analysis.hygieneEvents.map((h) => ({ hand: name(h.handId), at_s: h.t, agent: h.agent, effective_for_this_pathogen: h.effective })),
    glove_events: analysis.gloveEvents.map((g) => ({ hand: name(g.handId), at_s: g.t, type: g.type })),
    resident_exposures: analysis.propagation.residentExposures.map((x) => ({ resident: name(x.residentId), hand: name(x.handId), at_s: x.t })),
    moments_missed: analysis.momentMisses.map((m) => ({ moment: m.moment, hand: name(m.handId), at_s: m.t, hygiene_here_would_have_kept_clean: m.downstream.map(name) })),
    contaminated_at_end: analysis.propagation.contaminated.map(name),
    score: analysis.score,
  };
}

export function hashInput(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export function validateNarrative(json: unknown): { ok: true; narrative: Narrative } | { ok: false; reason: string } {
  const v = json as Partial<Record<keyof Narrative, unknown>>;
  for (const key of ["coaching_note", "audit_summary", "top_fix"] as const) {
    if (typeof v?.[key] !== "string" || !(v[key] as string).trim()) return { ok: false, reason: `${key} missing` };
  }
  const n = v as Narrative;
  const cw = words(n.coaching_note);
  if (cw < COACHING_WORDS[0] || cw > COACHING_WORDS[1]) return { ok: false, reason: `coaching_note is ${cw} words, needs ${COACHING_WORDS[0]} to ${COACHING_WORDS[1]}` };
  const aw = words(n.audit_summary);
  if (aw < AUDIT_WORDS[0] || aw > AUDIT_WORDS[1]) return { ok: false, reason: `audit_summary is ${aw} words, needs ${AUDIT_WORDS[0]} to ${AUDIT_WORDS[1]}` };
  if (words(n.top_fix) > TOP_FIX_WORDS) return { ok: false, reason: `top_fix is longer than one sentence` };
  for (const key of ["coaching_note", "audit_summary", "top_fix"] as const) {
    const hit = DISALLOWED.exec(n[key]);
    if (hit) return { ok: false, reason: `${key} contains disallowed clinical language: "${hit[0]}"` };
  }
  return { ok: true, narrative: { coaching_note: n.coaching_note.trim(), audit_summary: n.audit_summary.trim(), top_fix: n.top_fix.trim() } };
}

async function loadPrompt(): Promise<string> {
  return readFile(path.join(process.cwd(), "server", "prompts", "narrate.md"), "utf8");
}

export async function readNarrative(clipId: string): Promise<NarrativeFile | null> {
  const file = narrativePath(clipId);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as NarrativeFile;
}

export async function narrateClip(clipId: string, analysis: Analysis, backend: SparkBackend): Promise<NarrativeFile> {
  const input = trimForNarrative(analysis);
  const hash = hashInput(input);
  const cached = await readNarrative(clipId);
  if (cached && cached.hash === hash) return cached;

  const prompt = await loadPrompt();
  const baseText = `Analysis record:\n${JSON.stringify(input, null, 2)}`;
  let lastReason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = attempt === 0 ? baseText : `${baseText}\n\nYour previous answer failed validation: ${lastReason}. Try again and respect the word counts and the rules.`;
    let result;
    try {
      // Reasoning tokens count against this cap; the first live run used 2,205 of them at low effort.
      result = await backend.completeJson({ instructions: prompt, text, images: [], schemaName: "narrative", schema: NARRATIVE_SCHEMA, maxOutputTokens: 8000 });
    } catch (err) {
      lastReason = (err as Error).message;
      console.log(`spark   | ${clipId} | narrate attempt ${attempt + 1} failed: ${lastReason}`);
      continue;
    }
    const checked = validateNarrative(result.json);
    console.log(
      `spark   | ${clipId} | narrate attempt ${attempt + 1} | ${checked.ok ? "valid" : `INVALID: ${checked.reason}`} | in=${result.usage.inputTokens} (cached ${result.usage.cachedTokens}) out=${result.usage.outputTokens} (reasoning ${result.usage.reasoningTokens}) | ${String(result.elapsedMs).padStart(5)} ms | $${estimateSparkCost(result.usage).toFixed(4)}`,
    );
    if (checked.ok) {
      const file: NarrativeFile = { hash, model: backend.model, backend: backend.name, createdAt: new Date().toISOString(), usage: result.usage, narrative: checked.narrative };
      await writeFile(narrativePath(clipId), JSON.stringify(file, null, 2));
      return file;
    }
    lastReason = checked.reason;
  }
  throw new Error(`narrative failed validation twice: ${lastReason}`);
}

// Two sentences on a counterfactual. Not cached to disk; the client asks only on demand.
export async function explainCounterfactual(analysis: Analysis, cf: Counterfactual, backend: SparkBackend): Promise<string> {
  const label = new Map(analysis.entities.map((e) => [e.id, e.label]));
  const name = (id: string): string => label.get(id) ?? id;
  const input = {
    pathogen: analysis.pathogen.label,
    inserted: { hand: name(cf.inserted.handId), at_s: cf.inserted.t, agent: cf.inserted.agent, effective_for_this_pathogen: cf.inserted.effective },
    before: cf.before,
    after: cf.after,
    kept_clean: cf.keptClean.map(name),
  };
  const prompt = `${await loadPrompt()}\n\nFor this request, write exactly two sentences explaining the before and after numbers for the inserted hand hygiene event. Plain language. If the agent is not effective against the pathogen, say that is why nothing changed.`;
  const result = await backend.completeJson({ instructions: prompt, text: JSON.stringify(input, null, 2), images: [], schemaName: "counterfactual_explanation", schema: EXPLAIN_SCHEMA, maxOutputTokens: 4000 });
  const text = (result.json as { counterfactual_explanation?: unknown })?.counterfactual_explanation;
  if (typeof text !== "string" || !text.trim() || DISALLOWED.test(text)) throw new Error("counterfactual explanation failed validation");
  console.log(`spark   | ${analysis.clipId} | explain counterfactual at ${cf.inserted.t}s | in=${result.usage.inputTokens} out=${result.usage.outputTokens} | $${estimateSparkCost(result.usage).toFixed(4)}`);
  return text.trim();
}
