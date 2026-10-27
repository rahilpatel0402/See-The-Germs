// npm run narrate -- <clipId>
// Generates (or reuses) the Muse Spark narrative for a clip's current analysis.
import "../env.ts";
import { runAnalysis } from "../analysis.ts";
import { narrateClip } from "../narrate.ts";
import { MetaSparkBackend } from "../spark.ts";

const clipId = process.argv[2];
if (!clipId) {
  console.error("usage: npm run narrate -- <clipId>");
  process.exit(2);
}
const analysis = await runAnalysis(clipId);
const file = await narrateClip(clipId, analysis, new MetaSparkBackend());
console.log(`\nhash ${file.hash} via ${file.backend} ${file.model} (${file.createdAt})\n`);
console.log(`TOP FIX\n${file.narrative.top_fix}\n`);
console.log(`COACHING NOTE\n${file.narrative.coaching_note}\n`);
console.log(`AUDIT SUMMARY\n${file.narrative.audit_summary}`);
