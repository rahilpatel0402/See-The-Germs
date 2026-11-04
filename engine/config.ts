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
  // (600 ms at 10 fps). Shorter contacts go to adjudication. Raised from 5 on Nov 3 after the
  // feasibility labels: a 0.5 s brush of the rail while holding the remote below it was
  // confident at 5, and vision review had already judged it a pass.
  readonly confidentDwellFrames: number;
  // Heuristic: a contact that lasts this fraction of the clip or more goes to vision review
  // however thick it is. On outside footage (Oct 31, Nov 3) a prop between the camera and the
  // hands read as one long confident touch, 10 s of a 45 s clip in the mildest case; a real hold
  // that long survives review, a foreground prop does not.
  readonly reviewLongerThanFraction: number;
  // Heuristic: and at least this many hit frames (5 s at 10 fps), so a short clip is not sent
  // to review for an ordinary grip.
  readonly reviewLongerThanMinFrames: number;
  // Clinical weighting choice: every touch of a resident zone goes to vision review, however
  // thick. Resident contacts carry the most weight (exposures, Moments 1 and 4) and are the
  // ones a caregiver rubbing hands in front of the resident fakes most easily (shoot clips B and
  // C, Nov 3). They are reviewed outside the per-clip cap.
  readonly reviewResidentContacts: boolean;
}

export const CONTACT_CONFIG: ContactConfig = {
  dilationFraction: 0.015,
  floorPxAt720p: 150,
  openFrames: 3,
  closeFrames: 3,
  confidentIntersectionFactor: 2,
  confidentDwellFrames: 6,
  reviewLongerThanFraction: 0.2,
  reviewLongerThanMinFrames: 50,
  reviewResidentContacts: true,
};

// The frame size the pixel constants above were chosen at.
export const REFERENCE_FRAME: FrameSize = { w: 1280, h: 720 };

// Heuristic: SAM confidence gate for the "gloved hand" class. Measured Oct 31 on four clips:
// real gloves scored 0.81 to 0.96 at normal distance and 0.70 to 0.72 only in a wide shot with
// small hands; a bare hand or a loose glove held in a fist scored 0.71. The gate sits above the
// false positives seen so far and below every close-range true glove, so the wide-shot case is
// the one it gives up. Rerun the glove clips if this changes.
export const GLOVE_MIN_CONFIDENCE = 0.75;

// Heuristic: the scene loop accepts a SAM phrase on a still frame when it finds between
// minObjects and maxObjects instances at this mean confidence or better. One to three because a
// prop phrase that lights up half the room is describing a texture, not the prop.
export const SCENE_PHRASE_CONFIG = { minConfidence: 0.5, minObjects: 1, maxObjects: 3 } as const;

// The sampling rate every clip is resampled to before SAM. Frame index N is at N / SAMPLE_FPS s.
export const SAMPLE_FPS = 10;

export interface HygieneConfig {
  // Heuristic: a hand must dwell at a dispenser this long for it to count as a hygiene event
  // (PLAN.md 6.4). A brush past the bottle is not a rub.
  readonly minDwellS: number;
  // Clinical rule, WHO "How to Handrub" and "How to Handwash": alcohol-based handrub takes 20 to
  // 30 seconds, soap and water 40 to 60 seconds. The rub time is measured from reaching the
  // dispenser to the next touch. Below the minimum the event is inadequate.
  readonly minRubS: Readonly<Record<"alcohol_rub" | "soap_water", number>>;
  // Clinical rule choice: an inadequate rub does not count as effective. Confirmed by Rahil Oct 27.
  readonly inadequateIsIneffective: boolean;
}

export const HYGIENE_CONFIG: HygieneConfig = {
  minDwellS: 1.0,
  minRubS: { alcohol_rub: 20, soap_water: 40 },
  inadequateIsIneffective: true,
};

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
  // Heuristic: SAM reuses an object id when a hand comes back into view, so a hand object seen
  // again after this many frames without a record (1 s at 10 fps) counts as born again. That is
  // how skin reappearing after a glove comes off is seen when SAM keeps the old id (clip C).
  readonly rebirthGapFrames: number;
}

export const GLOVE_CONFIG: GloveConfig = {
  openFrames: 3,
  closeFrames: 3,
  handoverWindowFrames: 10,
  maxHandoverDistanceFraction: 0.15,
  rebirthGapFrames: 10,
};

// Clinical rule, confirmed by Rahil Oct 27: whether the bare hand is contaminated on doff
// depends on removal technique, and touching the glove's outer surface contaminates the hand.
// Technique is not visible to this pipeline, so it fails toward caution: on doff the hand gets
// its pre-glove state back and also inherits what the glove picked up. Stated in limitations.
export const DOFF_EXPOSES_BARE_HAND = true;

export interface AdjudicationConfig {
  // Heuristic: at most this many Spark vision calls per clip, to protect the credit budget
  // (PLAN.md 6.8). Contacts flagged long are reviewed outside the cap; of the rest the
  // lowest-overlap candidates go first and the remainder wait unreviewed, not counted as
  // contacts until a verdict exists.
  readonly capPerClip: number;
}

export const ADJUDICATION_CONFIG: AdjudicationConfig = { capPerClip: 12 };

// Clinical rule choice, proposed Tue Nov 3 after outside footage, for Rahil to confirm or flip:
// the first touch of a resident in a clip is a Moment 1 opportunity when the person's first
// touch of anything comes at least minLeadS into the clip (so the approach, and the chance to
// clean hands on camera, is in the clip), even if nothing outside the zone was touched first. WHO Moment 1 is before every approach to the patient; a clip that
// opens on the walk to the bed shows that approach.
export const FIRST_RESIDENT_CONTACT = { isOpportunity: true, minLeadS: 2 } as const;

// Clinical rule choice, proposed Tue Nov 3, for Rahil to confirm or flip: a contaminated hand
// touching the resident who is the chosen source is not a transmission, so it is not counted as
// an exposure. Only other residents are.
export const COUNT_EXPOSURE_OF_SOURCE_RESIDENT = false;

export interface PersonConfig {
  // Heuristic: a person object is the resident when at least this fraction of its frames have
  // most of its own box (this fraction of its area) lying on resident-zone records. A person
  // lying in bed sits inside the sheet and gown; a caregiver leaning over the bed does not.
  readonly residentFrameFraction: number;
  readonly residentCoverOfPersonArea: number;
  // Heuristic: and the person lies down: box height over width at most this. A standing or
  // leaning caregiver is taller than wide; a resident in bed is wider than tall.
  readonly residentMaxHeightOverWidth: number;
}

export const PERSON_CONFIG: PersonConfig = { residentFrameFraction: 0.5, residentCoverOfPersonArea: 0.6, residentMaxHeightOverWidth: 0.8 };

// Heuristic: ffmpeg scene score above which a frame starts a new shot. 0.4 separated real cuts
// from fast hand motion on nine outside clips (Oct 31); the engine never carries a prop across one.
export const CUT_SCENE_SCORE = 0.4;

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
