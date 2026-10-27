// Scores detected contacts against hand labels. Pure: labels and contacts in, a report out.
// A label matches a detection when hand, entity, and start time agree within the tolerance.
// Each label matches at most one detection and each detection at most one label, greedily in
// time order, so a long detection cannot absorb two separate labeled touches.

export interface LabeledContact {
  readonly handId: string;
  readonly entityId: string;
  readonly startT: number;
  readonly endT: number;
}

export interface DetectedContact {
  readonly handId: string;
  readonly entityId: string;
  readonly startT: number;
  readonly endT: number;
}

export interface AccuracyMatch {
  readonly label: LabeledContact;
  readonly detected: DetectedContact;
  readonly startErrorS: number;
}

export interface AccuracyReport {
  readonly toleranceS: number;
  readonly labels: number;
  readonly detections: number;
  readonly matched: number;
  // 1 when there are no detections, so an empty clean run is not penalized.
  readonly precision: number;
  // 1 when there are no labels.
  readonly recall: number;
  readonly matches: readonly AccuracyMatch[];
  readonly misses: readonly LabeledContact[];
  readonly falseAlarms: readonly DetectedContact[];
}

function byStart<T extends { startT: number }>(a: T, b: T): number {
  return a.startT - b.startT;
}

export function scoreContacts(
  labels: readonly LabeledContact[],
  detections: readonly DetectedContact[],
  toleranceS: number,
): AccuracyReport {
  if (!(toleranceS >= 0)) throw new Error(`scoreContacts: tolerance must be non-negative, got ${toleranceS}`);
  const sortedLabels = [...labels].sort(byStart);
  const sortedDetections = [...detections].sort(byStart);
  const usedDetection = new Set<number>();
  const matches: AccuracyMatch[] = [];
  const misses: LabeledContact[] = [];

  for (const label of sortedLabels) {
    let bestIndex = -1;
    let bestError = Number.POSITIVE_INFINITY;
    sortedDetections.forEach((d, i) => {
      if (usedDetection.has(i) || d.handId !== label.handId || d.entityId !== label.entityId) return;
      const error = Math.abs(d.startT - label.startT);
      if (error <= toleranceS && error < bestError) {
        bestError = error;
        bestIndex = i;
      }
    });
    if (bestIndex === -1) {
      misses.push(label);
    } else {
      usedDetection.add(bestIndex);
      matches.push({ label, detected: sortedDetections[bestIndex] as DetectedContact, startErrorS: bestError });
    }
  }

  const falseAlarms = sortedDetections.filter((_, i) => !usedDetection.has(i));
  const matched = matches.length;
  return {
    toleranceS,
    labels: labels.length,
    detections: detections.length,
    matched,
    precision: detections.length === 0 ? 1 : matched / detections.length,
    recall: labels.length === 0 ? 1 : matched / labels.length,
    matches,
    misses,
    falseAlarms,
  };
}
