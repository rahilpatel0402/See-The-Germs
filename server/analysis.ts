// Runs the engine over cached tracks and writes analysis.json. Pure engine in, JSON out; the
// only I/O is reading caches and writing the result. Adjudications are read as input when present.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { CONTACT_CONFIG } from "../engine/config.ts";
import { detectContacts } from "../engine/contacts.ts";
import type { Adjudication, Analysis, ContactEvent } from "../engine/types.ts";
import { HttpError } from "./errors.ts";
import { adjudicationsPath, analysisPath } from "./paths.ts";
import { loadTracks } from "./tracks.ts";

export async function readAdjudications(clipId: string): Promise<Adjudication[]> {
  const file = adjudicationsPath(clipId);
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, "utf8")) as Adjudication[];
}

export async function runAnalysis(clipId: string): Promise<Analysis> {
  const { tracks, missingPhrases } = await loadTracks(clipId);
  if (missingPhrases.length > 0) {
    throw new HttpError(409, `clip ${clipId} is not segmented for: ${missingPhrases.join(", ")}. Run segmentation first.`);
  }
  const candidates = detectContacts(tracks, CONTACT_CONFIG);
  const adjudications = await readAdjudications(clipId);
  const verdictFor = new Map(adjudications.map((a) => [a.candidateId, a.verdict]));

  // Confident candidates are contacts. Ambiguous ones are contacts only with a verdict of
  // touching or unclear (fail toward caution). Unadjudicated ambiguous candidates are not contacts yet.
  const contacts: ContactEvent[] = [];
  for (const c of candidates) {
    if (c.confidence === "confident") {
      contacts.push({ handId: c.handId, entityId: c.entityId, startT: c.startT, endT: c.endT, adjudicated: false });
      continue;
    }
    const verdict = verdictFor.get(c.id);
    if (verdict === "touching" || verdict === "unclear") {
      contacts.push({ handId: c.handId, entityId: c.entityId, startT: c.startT, endT: c.endT, adjudicated: true });
    }
  }

  const analysis: Analysis = { clipId, entities: tracks.entities, candidates, adjudications, contacts };
  await writeFile(analysisPath(clipId), JSON.stringify(analysis, null, 2));
  return analysis;
}
