// npm run adjudicate -- <clipId> [--force <candidateId> ...]
// Sends ambiguous candidates to Spark vision, caches the verdicts, and reruns the analysis.
// --force asks about a specific candidate id regardless of band and cap (development only; the
// engine still ignores verdicts on confident candidates).
import "../env.ts";
import { adjudicateClip } from "../adjudicate.ts";
import { runAnalysis } from "../analysis.ts";
import { createSparkBackend } from "../spark.ts";

const args = process.argv.slice(2);
const clipId = args[0];
if (!clipId || clipId.startsWith("--")) {
  console.error("usage: npm run adjudicate -- <clipId> [--force <candidateId> ...]");
  process.exit(2);
}
const force: string[] = [];
for (let i = 1; i < args.length; i++) if (args[i] === "--force" && args[i + 1]) force.push(args[++i] as string);

const run = await adjudicateClip(clipId, createSparkBackend(), { force });
console.log(`plan: ${run.plan.selected.length} selected, ${run.plan.skipped.length} skipped beyond the cap, ${force.length} forced, ${run.added.length} new verdicts, ${run.failed.length} failed (not cached), ${run.all.length} cached in total`);
for (const a of run.added) console.log(`  ${a.candidateId.padEnd(28)} ${a.verdict.padEnd(16)} ${a.reasoning}`);
for (const f of run.failed) console.log(`  ${f.candidateId.padEnd(28)} FAILED           ${f.reason}`);

const analysis = await runAnalysis(clipId);
console.log(`contacts after adjudication: ${analysis.contacts.length} (${analysis.contacts.filter((c) => c.adjudicated).length} adjudicated)`);
