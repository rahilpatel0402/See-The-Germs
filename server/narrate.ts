// Muse Spark text: structured analysis in, coaching note and audit summary out. Validated,
// retried once, cached per input hash so the same analysis never calls Spark twice and every
// scenario of a clip keeps its own narrative. The model explains; it never produces, edits, or
// overrides contacts, transfers, moments, or scores.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
// Reasoning tokens count against the output cap; the first live narrative used 3,150 of them.
const NARRATIVE_MAX_OUTPUT = 8000;
const EXPLAIN_MAX_OUTPUT = 4000;

// Anything that reads as patient-facing or clinical advice fails validation. Phrases, not bare
// nouns: a prop can legitimately be labelled "medication cart", and labels are exempted below.
// English and Spanish forms.
const DISALLOWED = /\b(diagnos\w*|diagn[oó]s\w*|prescri\w*|recet\w+|(take|give|adjust|stop|start) (the |your |their )?(medication|medicine|antibiotic)s?|(tom\w+|d[eé]|ajust\w+|suspend\w+) (el |la |los |las |su |sus )?(medicament\w+|medicin\w+|antibi[oó]tic\w+)|treat(ment)? plan|plan de tratamiento|see a doctor|consult\w+ (a|al) (m[eé]dico|doctor)|call (the|a) (doctor|physician)|should be (treated|tested|isolated|medicated)|debe(r[ií]a)? ser (tratad|aislad|medicad)\w*|the (resident|patient) (should|needs|must|requires)|(el|la) (residente|paciente) (debe|necesita|requiere))\b/i;

export type NarrativeLanguage = "en" | "es";

const LANGUAGE_NOTE: Record<NarrativeLanguage, string> = {
  en: "",
  es: "\n\nWrite the coaching_note in plain Spanish as spoken by nursing assistants in the United States (second person, usted), keeping the same length rules. Keep the entity labels exactly as given, in English, since they are the names on screen. Write the audit_summary and top_fix in English.",
};

// Finds disallowed language, ignoring the clip's own entity labels.
export function findDisallowed(text: string, labels: readonly string[]): string | null {
  let scrubbed = text;
  for (const label of labels) if (label) scrubbed = scrubbed.split(label).join(" ");
  const hit = DISALLOWED.exec(scrubbed);
  return hit ? hit[0] : null;
}

export interface NarrativeFile {
  readonly hash: string;
  readonly language?: NarrativeLanguage;
  readonly model: string;
  readonly backend: string;
  readonly createdAt: string;
  readonly usage: SparkUsage;
  readonly narrative: Narrative;
}

export interface ExplanationFile {
  readonly hash: string;
  readonly model: string;
  readonly backend: string;
  readonly createdAt: string;
  readonly usage: SparkUsage;
  readonly explanation: string;
}

export function narrativePath(clipId: string, hash: string): string {
  return path.join(clipDir(clipId), "narratives", `${hash}.json`);
}

export function explanationPath(clipId: string, hash: string): string {
  return path.join(clipDir(clipId), "explanations", `${hash}.json`);
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
    hygiene_events: analysis.hygieneEvents.map((h) => ({
      hand: name(h.handId),
      at_s: h.t,
      agent: h.agent,
      rub_duration_s: Number.isFinite(h.durationS) ? h.durationS : null,
      met_who_duration: h.adequate,
      effective_for_this_pathogen: h.effective,
    })),
    glove_events: analysis.gloveEvents.map((g) => ({ hand: name(g.handId), at_s: g.t, type: g.type })),
    glove_use_issues: analysis.gloveIssues.map((i) => ({ issue: i.type, hand: name(i.handId), at_s: i.t, involving: i.entityIds.map(name) })),
    hand_hygiene_compliance: {
      overall: analysis.compliance.overall,
      by_moment: analysis.compliance.byMoment,
    },
    surfaces_to_disinfect: analysis.cleaning.items.map((i) => ({ surface: i.label, contacts_while_contaminated: i.contactCount, is_source: i.isSource })),
    disinfectant: analysis.cleaning.disinfectantNote,
    resident_exposures: analysis.propagation.residentExposures.map((x) => ({ resident: name(x.residentId), hand: name(x.handId), at_s: x.t })),
    moments_missed: analysis.momentMisses.map((m) => ({ moment: m.moment, hand: name(m.handId), at_s: m.t, hygiene_here_would_have_kept_clean: m.downstream.map(name) })),
    contaminated_at_end: analysis.propagation.contaminated.map(name),
    score: analysis.score,
  };
}

export function hashInput(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

// The cache key covers the prompt too, so editing the prompt invalidates old narratives.
let promptCache: string | null = null;
async function promptText(): Promise<string> {
  if (promptCache === null) promptCache = await readFile(path.join(process.cwd(), "server", "prompts", "narrate.md"), "utf8");
  return promptCache;
}

// The cache key covers the prompt, the language, and the model, so each backend keeps its own
// narrative and the README comparison can show both.
export async function narrativeHash(analysis: Analysis, language: NarrativeLanguage = "en", model = "muse-spark-1.3"): Promise<string> {
  return hashInput({ prompt: await promptText(), language, model, input: trimForNarrative(analysis) });
}

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export function validateNarrative(json: unknown, labels: readonly string[] = []): { ok: true; narrative: Narrative } | { ok: false; reason: string } {
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
    const hit = findDisallowed(n[key], labels);
    if (hit) return { ok: false, reason: `${key} contains disallowed clinical language: "${hit}"` };
  }
  return { ok: true, narrative: { coaching_note: n.coaching_note.trim(), audit_summary: n.audit_summary.trim(), top_fix: n.top_fix.trim() } };
}

async function loadPrompt(): Promise<string> {
  return promptText();
}

async function readJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

// The cached narrative for exactly this analysis, or null.
export async function readNarrative(clipId: string, analysis: Analysis, language: NarrativeLanguage = "en", model = "muse-spark-1.3"): Promise<NarrativeFile | null> {
  return readJson<NarrativeFile>(narrativePath(clipId, await narrativeHash(analysis, language, model)));
}

export async function narrateClip(clipId: string, analysis: Analysis, backend: SparkBackend, language: NarrativeLanguage = "en"): Promise<NarrativeFile> {
  const input = trimForNarrative(analysis);
  const hash = await narrativeHash(analysis, language, backend.model);
  const cached = await readJson<NarrativeFile>(narrativePath(clipId, hash));
  if (cached) return cached;

  const prompt = (await loadPrompt()) + LANGUAGE_NOTE[language];
  const baseText = `Analysis record:\n${JSON.stringify(input, null, 2)}`;
  let lastReason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = attempt === 0 ? baseText : `${baseText}\n\nYour previous answer failed validation: ${lastReason}. Try again and respect the word counts and the rules.`;
    let result;
    try {
      result = await backend.completeJson({ instructions: prompt, text, images: [], schemaName: "narrative", schema: NARRATIVE_SCHEMA, maxOutputTokens: NARRATIVE_MAX_OUTPUT });
    } catch (err) {
      lastReason = (err as Error).message;
      console.log(`spark   | ${clipId} | narrate attempt ${attempt + 1} failed: ${lastReason}`);
      continue;
    }
    const checked = validateNarrative(result.json, analysis.entities.map((e) => e.label));
    console.log(
      `spark   | ${clipId} | narrate ${language} attempt ${attempt + 1} | ${checked.ok ? "valid" : `INVALID: ${checked.reason}`} | in=${result.usage.inputTokens} (cached ${result.usage.cachedTokens}) out=${result.usage.outputTokens} (reasoning ${result.usage.reasoningTokens}) | ${String(result.elapsedMs).padStart(5)} ms | $${estimateSparkCost(result.usage).toFixed(4)}`,
    );
    if (checked.ok) {
      const file: NarrativeFile = { hash, language, model: backend.model, backend: backend.name, createdAt: new Date().toISOString(), usage: result.usage, narrative: checked.narrative };
      await writeJson(narrativePath(clipId, hash), file);
      return file;
    }
    lastReason = checked.reason;
  }
  throw new Error(`narrative failed validation twice: ${lastReason}`);
}

// Two sentences on a counterfactual, cached per clip, scenario, time, and agent.
export async function explainCounterfactual(analysis: Analysis, cf: Counterfactual, backend: SparkBackend): Promise<ExplanationFile> {
  const label = new Map(analysis.entities.map((e) => [e.id, e.label]));
  const name = (id: string): string => label.get(id) ?? id;
  const input = {
    pathogen: analysis.pathogen.label,
    scenario_source: name(analysis.scenario.sourceEntityId),
    inserted: { hand: name(cf.inserted.handId), at_s: cf.inserted.t, agent: cf.inserted.agent, effective_for_this_pathogen: cf.inserted.effective },
    before: cf.before,
    after: cf.after,
    kept_clean: cf.keptClean.map(name),
  };
  const prompt = `${await loadPrompt()}\n\nFor this request, write exactly two sentences explaining the before and after numbers for the inserted hand hygiene event. Plain language. If the agent is not effective against the pathogen, say that is why nothing changed.`;
  const hash = hashInput({ prompt, model: backend.model, input });
  const cached = await readJson<ExplanationFile>(explanationPath(analysis.clipId, hash));
  if (cached) return cached;
  const result = await backend.completeJson({ instructions: prompt, text: JSON.stringify(input, null, 2), images: [], schemaName: "counterfactual_explanation", schema: EXPLAIN_SCHEMA, maxOutputTokens: EXPLAIN_MAX_OUTPUT });
  const text = (result.json as { counterfactual_explanation?: unknown })?.counterfactual_explanation;
  if (typeof text !== "string" || !text.trim() || findDisallowed(text, analysis.entities.map((e) => e.label)) !== null) throw new Error("counterfactual explanation failed validation");
  console.log(`spark   | ${analysis.clipId} | explain counterfactual at ${cf.inserted.t}s | in=${result.usage.inputTokens} out=${result.usage.outputTokens} | $${estimateSparkCost(result.usage).toFixed(4)}`);
  const file: ExplanationFile = { hash, model: backend.model, backend: backend.name, createdAt: new Date().toISOString(), usage: result.usage, explanation: text.trim() };
  await writeJson(explanationPath(analysis.clipId, hash), file);
  return file;
}
