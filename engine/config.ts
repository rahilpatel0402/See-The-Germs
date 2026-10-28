// Heuristic constants. Every value here is a tuning choice, not a clinical fact. Each has a
// one-line reason. Do not change a value without rerunning `npm run accuracy`.

import type { FrameSize } from "./types.ts";

export interface ContactConfig {
  // Heuristic: dilate the hand mask by this fraction of frame width before testing overlap,
  // because the object mask excludes the pixels the hand covers, so raw intersection is near
  // zero even during a real grip (feasibility clip, Oct 26).
  readonly dilationFraction: number;
  // Heuristic: minimum dilated intersection, in pixels at 1280x720, to count a frame as a hit.
  // Scaled by frame area for other sizes. Filters single-pixel brushes.
  readonly floorPxAt720p: number;
  // Heuristic: consecutive hit frames needed to open a candidate (300 ms at 10 fps).
  readonly openFrames: number;
  // Heuristic: consecutive miss frames needed to close a candidate (300 ms at 10 fps).
  readonly closeFrames: number;
  // Heuristic: a candidate is confident only if its peak intersection is at least this many
  // times the floor. Below it, the overlap is thin and goes to adjudication.
  readonly confidentIntersectionFactor: number;
  // Heuristic: a candidate is confident only if it dwelt at least this many hit frames
  // (500 ms at 10 fps). Shorter contacts go to adjudication.
  readonly confidentDwellFrames: number;
}

export const CONTACT_CONFIG: ContactConfig = {
  dilationFraction: 0.015,
  floorPxAt720p: 150,
  openFrames: 3,
  closeFrames: 3,
  confidentIntersectionFactor: 2,
  confidentDwellFrames: 5,
};

// The frame size the pixel constants above were chosen at.
export const REFERENCE_FRAME: FrameSize = { w: 1280, h: 720 };

// Heuristic: the "gloved hand" SAM class fired at 0.71 confidence on a bare hand once in the
// feasibility clip and at 0.93 on the real glove, so a glove track below this is ignored.
export const GLOVE_MIN_CONFIDENCE = 0.85;

// The sampling rate every clip is resampled to before SAM. Frame index N is at N / SAMPLE_FPS s.
export const SAMPLE_FPS = 10;

export interface HygieneConfig {
  // Heuristic: a hand must dwell at a dispenser this long for it to count as a hygiene event
  // (PLAN.md 6.4). A brush past the bottle is not a rub.
  readonly minDwellS: number;
}

export const HYGIENE_CONFIG: HygieneConfig = { minDwellS: 1.0 };

export interface GloveConfig {
  // Heuristic: consecutive frames the gloved class must be present to count as a glove on.
  readonly openFrames: number;
  // Heuristic: consecutive frames the gloved class must be absent to count as a glove off.
  readonly closeFrames: number;
  // Heuristic: how far back (don) or forward (doff) to look for the bare hand, in frames
  // (1.0 s at 10 fps, PLAN.md 6.4).
  readonly handoverWindowFrames: number;
  // Heuristic: the bare and gloved tracks must be within this fraction of frame width for the
  // handover to be the same hand.
  readonly maxHandoverDistanceFraction: number;
}

export const GLOVE_CONFIG: GloveConfig = {
  openFrames: 3,
  closeFrames: 3,
  handoverWindowFrames: 10,
  maxHandoverDistanceFraction: 0.15,
};

// Clinical rule, confirmed by Rahil Oct 27: whether the bare hand is contaminated on doff
// depends on removal technique, and touching the glove's outer surface contaminates the hand.
// Technique is not visible to this pipeline, so it fails toward caution: on doff the hand gets
// its pre-glove state back and also inherits what the glove picked up. Stated in limitations.
export const DOFF_EXPOSES_BARE_HAND = true;

export interface AdjudicationConfig {
  // Heuristic: at most this many Spark vision calls per clip, to protect the credit budget
  // (PLAN.md 6.8). Lowest-overlap candidates go first; the rest stay contacts unreviewed.
  readonly capPerClip: number;
}

export const ADJUDICATION_CONFIG: AdjudicationConfig = { capPerClip: 12 };

export interface GapFillConfig {
  readonly enabled: boolean;
  // Heuristic: two sightings whose boxes overlap at least this much (IoU) are the same static
  // placement, so the whole gap between them is filled with the earlier sighting.
  readonly staticIoU: number;
  // Heuristic: when the object moved between sightings, fill at most this many frames on each
  // side of the gap (1 s at 10 fps), which covers the grasp and the release.
  readonly maxMovingGapFrames: number;
  // Heuristic: a staged, fixed-camera scene has every prop in place from the first frame, so an
  // object first detected late is assumed to have been there since frame 0.
  readonly backfillFromFirstSighting: boolean;
  // Heuristic: likewise, an object last seen before the end is assumed to stay where it was.
  readonly forwardFillToEnd: boolean;
}

export const GAP_FILL_CONFIG: GapFillConfig = {
  enabled: true,
  staticIoU: 0.5,
  maxMovingGapFrames: 10,
  backfillFromFirstSighting: true,
  forwardFillToEnd: true,
};

export interface ScoreWeights {
  readonly residentExposure: number;
  readonly contaminatedSurface: number;
  readonly momentMiss: number;
}

// Heuristic weights from PLAN.md 6.6, shown in the UI as a heuristic. They exist so the
// counterfactual has a before and after number.
export const SCORE_WEIGHTS: ScoreWeights = { residentExposure: 10, contaminatedSurface: 3, momentMiss: 2 };

// Dilation radius in pixels for a given frame width, never less than one pixel.
export function dilationPx(config: ContactConfig, frameSize: FrameSize): number {
  return Math.max(1, Math.round(frameSize.w * config.dilationFraction));
}

// The hit floor scaled from the reference frame to this frame by area, never less than one pixel.
export function scaledFloorPx(config: ContactConfig, frameSize: FrameSize): number {
  const scale = (frameSize.w * frameSize.h) / (REFERENCE_FRAME.w * REFERENCE_FRAME.h);
  return Math.max(1, Math.round(config.floorPxAt720p * scale));
}
