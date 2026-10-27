// npm run analyze -- <clipId>
// Probes and resamples the clip if needed, segments any phrase without a cached track, runs the
// engine, writes analysis.json, and prints the contact timeline to compare with reality.
import "../env.ts";
import { runAnalysis } from "../analysis.ts";
import { ensureClip } from "../clips.ts";
import { readEntities } from "../entities.ts";
import { MetaSamBackend, segmentPhrase } from "../sam.ts";

const clipId = process.argv[2];
if (!clipId) {
  console.error("usage: npm run analyze -- <clipId>");
  process.exit(2);
}

const meta = await ensureClip(clipId);
console.log(`clip    | ${clipId} | source ${meta.source.width}x${meta.source.height} ${meta.source.fps.toFixed(2)} fps ${meta.source.durationS.toFixed(1)} s | sampled ${meta.sampled.width}x${meta.sampled.height} ${meta.sampled.frames} frames at ${meta.fps} fps`);

const entities = await readEntities(clipId);
const backend = new MetaSamBackend();
for (const phrase of new Set(entities.map((e) => e.samPhrase))) {
  const track = await segmentPhrase(clipId, phrase, backend);
  const frames = new Set(track.records.map((r) => r.frameIndex)).size;
  const objects = new Set(track.records.map((r) => r.objectId)).size;
  console.log(`track   | ${phrase.padEnd(24)} | frames=${String(frames).padStart(4)} objects=${objects}`);
}

const analysis = await runAnalysis(clipId);
const label = new Map(entities.map((e) => [e.id, e.label]));
console.log("\ncontact candidates:");
for (const c of analysis.candidates) {
  const mark = c.confidence === "confident" ? "confident" : "AMBIGUOUS";
  console.log(
    `  ${c.startT.toFixed(1).padStart(5)} to ${c.endT.toFixed(1).padStart(5)} s  ${(label.get(c.handId) ?? c.handId).padEnd(12)} -> ${(label.get(c.entityId) ?? c.entityId).padEnd(20)} ${mark.padEnd(9)} dwell=${String(c.dwellFrames).padStart(3)} peak=${c.peakIntersectionPx}px`,
  );
}
console.log(`\ncontacts after adjudication rules: ${analysis.contacts.length} (ambiguous candidates without a verdict are excluded)`);
console.log(`analysis written to data/clips/${clipId}/analysis.json`);
