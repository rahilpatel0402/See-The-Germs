// Chooses which ambiguous contact candidates go to vision adjudication and which frames to
// show. Pure. The verdicts themselves come back as input to the engine; nothing here calls a model.

import type { AdjudicationConfig } from "./config.ts";
import type { Adjudication, ContactCandidate } from "./types.ts";

export interface AdjudicationFrames {
  readonly first: number;
  readonly middle: number;
}

export interface AdjudicationPlan {
  // Ambiguous candidates without a cached verdict, within the cap, in start order.
  readonly selected: readonly ContactCandidate[];
  // Eligible candidates beyond the cap. Without a verdict they are not contacts (CLAUDE.md:
  // ambiguous candidates become contacts only with verdict touching or unclear), so the UI
  // shows them as not yet reviewed, not counted.
  readonly skipped: readonly ContactCandidate[];
  readonly frames: Readonly<Record<string, AdjudicationFrames>>;
}

export function framesFor(candidate: ContactCandidate): AdjudicationFrames {
  return { first: candidate.startFrame, middle: Math.floor((candidate.startFrame + candidate.endFrame) / 2) };
}

export function planAdjudication(
  candidates: readonly ContactCandidate[],
  existing: readonly Adjudication[],
  config: AdjudicationConfig,
): AdjudicationPlan {
  // Only verdicts on candidates that still exist count: a retune or a phrase change can leave
  // stale ids behind, and those must not eat the cap forever.
  const currentIds = new Set(candidates.map((c) => c.id));
  const done = new Set(existing.filter((a) => currentIds.has(a.candidateId)).map((a) => a.candidateId));
  const eligible = candidates.filter((c) => c.confidence === "ambiguous" && !done.has(c.id));
  // Live verdicts count against the cap, so a clip never exceeds it across runs.
  const budget = Math.max(0, config.capPerClip - done.size);
  // Lowest overlap first: the thinnest contacts are the ones most worth a second look.
  const byOverlap = [...eligible].sort(
    (a, b) => a.peakIntersectionPx - b.peakIntersectionPx || a.startFrame - b.startFrame || a.id.localeCompare(b.id),
  );
  const chosen = new Set(byOverlap.slice(0, budget).map((c) => c.id));
  const byStart = (a: ContactCandidate, b: ContactCandidate): number => a.startFrame - b.startFrame || a.id.localeCompare(b.id);
  const selected = eligible.filter((c) => chosen.has(c.id)).sort(byStart);
  const skipped = eligible.filter((c) => !chosen.has(c.id)).sort(byStart);
  const frames: Record<string, AdjudicationFrames> = {};
  for (const c of selected) frames[c.id] = framesFor(c);
  return { selected, skipped, frames };
}
