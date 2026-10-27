// npm run accuracy -- <clipId> [<clipId> ...]
// Compares analysis.json contacts against hand labels in data/clips/<id>/labels.json with a
// 1.0 s start tolerance, prints precision and recall, and lists every miss and false alarm.
// Also reports which misses were ambiguous candidates, since those are what adjudication is for.
import "../env.ts";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreContacts, type LabeledContact } from "../../engine/accuracy.ts";
import type { Analysis } from "../../engine/types.ts";
import { readEntities } from "../entities.ts";
import { analysisPath, clipDir } from "../paths.ts";

const TOLERANCE_S = 1.0;

// labels.json as described in docs/DEV_CLIP_SHOOT.md. hand is "bare" or "gloved" and maps to the
// clip's hand entity of that class; entity is an entity id from entities.json.
interface LabelsFile {
  readonly clipId: string;
  readonly contacts: ReadonlyArray<{ hand: "bare" | "gloved"; entity: string; startT: number; endT: number }>;
  readonly nonContacts?: ReadonlyArray<{ hand: "bare" | "gloved"; entity: string; startT: number; endT: number; note?: string }>;
}

const clipIds = process.argv.slice(2);
if (clipIds.length === 0) {
  console.error("usage: npm run accuracy -- <clipId> [<clipId> ...]");
  process.exit(2);
}

const rows: string[] = ["| Clip | Labels | Detected | Precision | Recall | Misses | False alarms |", "| --- | --- | --- | --- | --- | --- | --- |"];
for (const clipId of clipIds) {
  const labelsFile = path.join(clipDir(clipId), "labels.json");
  if (!existsSync(labelsFile)) {
    console.error(`${clipId}: no labels.json, skipping`);
    continue;
  }
  if (!existsSync(analysisPath(clipId))) {
    console.error(`${clipId}: no analysis.json, run npm run analyze -- ${clipId} first`);
    continue;
  }
  const labels = JSON.parse(await readFile(labelsFile, "utf8")) as LabelsFile;
  const analysis = JSON.parse(await readFile(analysisPath(clipId), "utf8")) as Analysis;
  const entities = await readEntities(clipId);
  const handFor = (hand: "bare" | "gloved"): string => {
    const cls = hand === "bare" ? "bare_hand" : "gloved_hand";
    const entity = entities.find((e) => e.class === cls);
    if (!entity) throw new Error(`${clipId}: no ${cls} entity in entities.json`);
    return entity.id;
  };
  const labeled: LabeledContact[] = labels.contacts.map((c) => ({ handId: handFor(c.hand), entityId: c.entity, startT: c.startT, endT: c.endT }));
  const report = scoreContacts(labeled, analysis.contacts, TOLERANCE_S);
  const label = new Map(entities.map((e) => [e.id, e.label]));
  const name = (handId: string, entityId: string) => `${label.get(handId) ?? handId} -> ${label.get(entityId) ?? entityId}`;

  console.log(`\n${clipId}: precision ${report.precision.toFixed(2)} recall ${report.recall.toFixed(2)} (${report.matched} of ${report.labels} labels matched, ${report.detections} detections, tolerance ${TOLERANCE_S} s)`);
  for (const m of report.matches) console.log(`  match        ${m.label.startT.toFixed(1).padStart(5)} s  ${name(m.label.handId, m.label.entityId)}  (start error ${m.startErrorS.toFixed(1)} s)`);
  for (const miss of report.misses) {
    const ambiguous = analysis.candidates.find((c) => c.confidence === "ambiguous" && c.handId === miss.handId && c.entityId === miss.entityId && Math.abs(c.startT - miss.startT) <= TOLERANCE_S);
    console.log(`  MISS         ${miss.startT.toFixed(1).padStart(5)} s  ${name(miss.handId, miss.entityId)}${ambiguous ? "  (an ambiguous candidate exists, awaiting adjudication)" : "  (no candidate at all)"}`);
  }
  for (const fa of report.falseAlarms) {
    const staged = labels.nonContacts?.find((n) => handFor(n.hand) === fa.handId && n.entity === fa.entityId && Math.abs(n.startT - fa.startT) <= TOLERANCE_S);
    console.log(`  FALSE ALARM  ${fa.startT.toFixed(1).padStart(5)} s  ${name(fa.handId, fa.entityId)}${staged ? `  (staged non-contact: ${staged.note ?? "pass in front"})` : ""}`);
  }
  rows.push(`| ${clipId} | ${report.labels} | ${report.detections} | ${report.precision.toFixed(2)} | ${report.recall.toFixed(2)} | ${report.misses.length} | ${report.falseAlarms.length} |`);
  await writeFile(path.join(clipDir(clipId), "accuracy.json"), JSON.stringify(report, null, 2));
}
console.log("\n" + rows.join("\n"));
