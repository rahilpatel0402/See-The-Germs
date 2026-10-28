// npm run phrase -- <clipId> <frameIndex> "<phrase>" ["<phrase>" ...]
// Tests candidate SAM phrases on one sampled frame ($0.0025 each) and writes an annotated PNG
// per phrase to data/clips/<id>/phrases/, so weak phrases are caught before a clip run.
import "../env.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureClip } from "../clips.ts";
import { rawFramePath, renderAnnotatedFrame } from "../frames.ts";
import { clipDir } from "../paths.ts";
import { segmentImage } from "../sam.ts";

const [clipId, frameArg, ...phrases] = process.argv.slice(2);
if (!clipId || !frameArg || phrases.length === 0) {
  console.error('usage: npm run phrase -- <clipId> <frameIndex> "<phrase>" ["<phrase>" ...]');
  process.exit(2);
}
const frameIndex = Number(frameArg);
const meta = await ensureClip(clipId);
if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= meta.sampled.frames) {
  console.error(`frameIndex must be 0 to ${meta.sampled.frames - 1}`);
  process.exit(2);
}
const png = await readFile(await rawFramePath(clipId, frameIndex));
const outDir = path.join(clipDir(clipId), "phrases");
await mkdir(outDir, { recursive: true });

for (const phrase of phrases) {
  const { records, elapsedMs } = await segmentImage(png, phrase);
  const objects = new Set(records.map((r) => r.objectId)).size;
  const conf = records.map((r) => r.confidence ?? NaN).filter((c) => !Number.isNaN(c));
  const meanConf = conf.length ? (conf.reduce((a, b) => a + b, 0) / conf.length).toFixed(2) : "?";
  const boxes = records.map((r) => `${r.bounds.left},${r.bounds.top} ${r.bounds.right - r.bounds.left}x${r.bounds.bottom - r.bounds.top}`).join("; ");
  console.log(`phrase  | ${clipId} f${frameIndex} | ${phrase.padEnd(36)} | objects=${objects} conf=${meanConf} | ${String(elapsedMs).padStart(5)} ms | ${boxes || "no match"}`);
  if (records.length > 0) {
    const annotated = await renderAnnotatedFrame(clipId, frameIndex, [{ records, color: "#ff00c8" }]);
    await writeFile(path.join(outDir, `f${frameIndex}-${phrase.replace(/[^a-z0-9]+/gi, "_")}.png`), annotated);
  }
}
console.log(`annotated frames in ${outDir}`);
