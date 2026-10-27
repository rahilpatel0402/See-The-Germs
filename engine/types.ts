// Shared engine types. The definitions in CLAUDE.md are the source of truth; this file is their
// TypeScript form. The engine is pure: these are plain data, no classes, no methods.

export type ZoneTag = "patient_zone_A" | "patient_zone_B" | "healthcare_area" | "hygiene_station";

export type EntityClass = "bare_hand" | "gloved_hand" | "object" | "resident_zone" | "dispenser";

export type HygieneAgent = "alcohol_rub" | "soap_water";

// What a dwell at a dispenser produces.
export type DispenserAgent = HygieneAgent | "gloves";

export interface Entity {
  readonly id: string;
  // Shown in the UI, for example "bed rail A".
  readonly label: string;
  readonly class: EntityClass;
  readonly zone: ZoneTag;
  // The noun phrase SAM was asked for, for example "white rod". Kept separate from the label
  // because SAM matches appearance, not function (see docs/API_NOTES.md section 11).
  readonly samPhrase: string;
  // Hands only. The bare hand and gloved hand classes of one person are the same physical
  // hands; hand state is keyed by person. Defaults to "P1".
  readonly person?: string;
  // Dispensers only. Required for a dispenser to produce hygiene or glove events.
  readonly agent?: DispenserAgent;
  // Objects only. Contact with this entity is a clean or aseptic task (Moment 2).
  readonly aseptic?: boolean;
}

export interface FrameSize {
  readonly w: number;
  readonly h: number;
}

// Half-open box in source pixels: right and bottom are one past the last pixel.
export interface MaskBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type MaskEncoding = "one_bit" | "lossless";

// One SAM mask record as cached under data/clips/<id>/tracks/<class>.json. The payload is the
// base85 text after the encoding marker, exactly as the API emitted it.
export interface MaskRecord {
  readonly frameIndex: number;
  readonly objectId: string;
  readonly bounds: MaskBounds;
  readonly confidence?: number;
  readonly mask: {
    readonly encoding: MaskEncoding;
    readonly width: number;
    readonly height: number;
    readonly payload: string;
  };
}

// A full-frame binary raster, row-major, each entry 0 or 1, length w * h.
export interface FrameMask {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
}

// Everything the contact detector needs. masksAt returns the masks present in a frame keyed by
// entity id; a missing entity means not visible. It is a function so the caller can decode
// lazily: a full-frame raster per entity per frame does not fit in memory for a long clip.
// The engine only ever walks frames in order and looks back a few frames.
export interface Tracks {
  readonly frameSize: FrameSize;
  readonly fps: number;
  // Frames are 0 to frameCount - 1.
  readonly frameCount: number;
  readonly entities: readonly Entity[];
  masksAt(frameIndex: number): ReadonlyMap<string, FrameMask>;
}

export type CandidateConfidence = "confident" | "ambiguous";

export interface ContactCandidate {
  readonly id: string;
  readonly handId: string;
  readonly entityId: string;
  readonly startT: number;
  readonly endT: number;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly confidence: CandidateConfidence;
  readonly peakIntersectionPx: number;
  readonly dwellFrames: number;
}

export type Verdict = "touching" | "passing_in_front" | "unclear";

export interface Adjudication {
  readonly candidateId: string;
  readonly verdict: Verdict;
  readonly reasoning: string;
}

export interface ContactEvent {
  readonly handId: string;
  readonly entityId: string;
  readonly startT: number;
  readonly endT: number;
  readonly adjudicated: boolean;
}

export interface TransferEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly t: number;
}

export interface HygieneEvent {
  readonly handId: string;
  readonly t: number;
  readonly agent: HygieneAgent;
  readonly effective: boolean;
}

export interface GloveEvent {
  readonly handId: string;
  readonly t: number;
  readonly type: "don" | "doff";
  readonly source: "detected" | "manual";
}

export interface MomentMiss {
  readonly moment: 1 | 2 | 4 | 5;
  readonly handId: string;
  readonly t: number;
  readonly downstream: readonly string[];
}

export type PathogenId = "mrsa" | "c_auris" | "c_difficile" | "norovirus";

export interface PathogenProfile {
  readonly id: PathogenId;
  readonly label: string;
  readonly alcoholRubClearsHands: boolean;
  readonly soapWaterClearsHands: boolean;
  // Seconds. All four persist far longer than any clip, so this is effectively infinite and
  // exists so the model is honest about having the field.
  readonly surfacePersistenceS: number;
  readonly uiNote: string;
  // CDC and WHO sources, supplied by Rahil, cited in the README.
  readonly citations: readonly string[];
}

export interface Scenario {
  // The entity contaminated at t = 0.
  readonly sourceEntityId: string;
  readonly pathogen: PathogenId;
}

export interface GloveBoxTouch {
  readonly handId: string;
  readonly t: number;
}

export interface ResidentExposure {
  readonly residentId: string;
  readonly handId: string;
  readonly t: number;
}

export type ContaminationCause = "source" | "transfer" | "hygiene" | "glove_don" | "glove_doff";

export interface ContaminationChange {
  readonly t: number;
  readonly entityId: string;
  readonly contaminated: boolean;
  readonly cause: ContaminationCause;
}

export interface HandState {
  readonly contaminated: boolean;
  readonly gloved: boolean;
}

export interface PropagationResult {
  // Entity ids contaminated at the end of the clip, hands included (every hand entity of a
  // contaminated person is listed).
  readonly contaminated: readonly string[];
  readonly hands: Readonly<Record<string, HandState>>;
  readonly transfers: readonly TransferEdge[];
  readonly residentExposures: readonly ResidentExposure[];
  readonly changes: readonly ContaminationChange[];
  // Hops from the source along transfer edges, keyed by entity id for objects and residents
  // and by "person:<id>" for hands. The source is 0.
  readonly hops: Readonly<Record<string, number>>;
}

export interface ExposureScore {
  readonly contaminatedSurfaces: number;
  readonly chainLength: number;
  readonly residentExposures: Readonly<Record<string, number>>;
  readonly momentsMissed: Readonly<Record<"1" | "2" | "4" | "5", number>>;
  readonly score: number;
}

// One inserted hand hygiene event and what changes because of it. A pure rerun of the engine.
export interface Counterfactual {
  readonly inserted: HygieneEvent;
  readonly before: ExposureScore;
  readonly after: ExposureScore;
  // Entities contaminated before the insertion and clean after it.
  readonly keptClean: readonly string[];
  readonly propagation: PropagationResult;
  readonly momentMisses: readonly MomentMiss[];
}

// Muse Spark text output. It explains the analysis and never changes it.
export interface Narrative {
  readonly coaching_note: string;
  readonly audit_summary: string;
  readonly top_fix: string;
}

// The full output object. Once the Muse Spark prompt and the client consume it, this shape
// does not change without updating both in the same commit.
export interface Analysis {
  readonly clipId: string;
  readonly scenario: Scenario;
  readonly pathogen: PathogenProfile;
  readonly entities: readonly Entity[];
  readonly candidates: readonly ContactCandidate[];
  readonly adjudications: readonly Adjudication[];
  readonly contacts: readonly ContactEvent[];
  readonly hygieneEvents: readonly HygieneEvent[];
  readonly gloveBoxTouches: readonly GloveBoxTouch[];
  readonly gloveEvents: readonly GloveEvent[];
  readonly propagation: PropagationResult;
  readonly momentMisses: readonly MomentMiss[];
  readonly score: ExposureScore;
}
