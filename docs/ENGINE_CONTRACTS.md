# Engine module contracts

CLAUDE.md: before writing a new module, state its input and output types in one paragraph and wait for a yes. Modules are added here the evening before they are written. Everything under `engine/` is pure TypeScript, no I/O, no model calls, tested with node:test.

## masks.ts (Tue Oct 27)

Input: a `MaskRecord` as cached from SAM per frame per object: `{ frameIndex: number; objectId: string; bounds: { left, top, right, bottom } (half-open, source pixels); confidence?: number; mask: { encoding: "one_bit" | "lossless"; width; height; payload: string } }`, plus the frame size `{ w, h }`. Decoding the base85 payload to a raster is delegated to `@meta-sam/parser`'s `decodeMaskToRaster`; masks.ts wraps it.

Output: a `FrameMask` = `{ w, h, data: Uint8Array }` (row-major, 0 or 1, full frame size) and pure functions over it: `fromRecord(record, frameSize): FrameMask`, `dilate(mask, k): FrameMask` (square structuring element, k pixels), `intersectArea(a, b): number`, `area(mask): number`, `bbox(mask)`. Deterministic, allocation-explicit, no side effects. Tests use tiny hand-built 8x8 rasters, not SAM output.

Why this shape: the feasibility clip showed raw mask intersection is near zero even during a real grip because the object mask excludes the pixels the hand covers, so dilation is not optional and has to live in one tested place.

## contacts.ts (Tue Oct 27)

Input: `Tracks` = `{ frameSize: { w, h }; fps: number; entities: Entity[]; frames: Map<number, Map<entityId, FrameMask>> }` where `Entity = { id, label, class: "bare_hand" | "gloved_hand" | "object" | "resident_zone" | "dispenser"; zone: ZoneTag; samPhrase: string }`, plus `ContactConfig` from `engine/config.ts`: `{ dilationFraction: 0.015; floorPx: 150 (at 720p, scaled by frame area); openFrames: 3; closeFrames: 3; confidentIntersectionFactor: 2; confidentDwellFrames: 5 }`.

Output: `ContactCandidate[]` exactly as CLAUDE.md defines it: `{ id, handId, entityId, startT, endT, confidence: "confident" | "ambiguous", peakIntersectionPx, dwellFrames }`, sorted by startT. A candidate opens after `openFrames` consecutive hits above the floor and closes after `closeFrames` consecutive misses. Confident when peak intersection is at least `confidentIntersectionFactor` times the floor and dwell is at least `confidentDwellFrames`; otherwise ambiguous. Hand-to-dispenser overlaps are emitted as candidates too (propagation turns them into hygiene events later). Pure: same tracks and config, same output.

Why this shape: on the feasibility clip these exact rules reproduced every real touch within a second and put the 0.4 s reach-across in the ambiguous band, and the engine never needs to know masks came from SAM.

## gloves.ts, propagation.ts, moments.ts, score.ts (Wed Oct 28)
To be stated Tuesday night after Gate 2.
