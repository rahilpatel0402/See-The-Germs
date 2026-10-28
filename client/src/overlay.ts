// Overlay geometry and state replay. No React here. Masks are decoded once per frame on first
// use and cached as Path2D; contamination at time t is replayed from the analysis changes, so
// the same analysis and the same t always draw the same pixels.
import { decodeMaskToSVGPath } from "@meta-sam/parser";
import type { Analysis, Entity, MaskRecord, PropagationResult } from "../../engine/types.ts";
import type { TracksPayload } from "./api.ts";

export interface Shape {
  readonly entityId: string;
  readonly path: Path2D;
  readonly left: number;
  readonly top: number;
  // The object was not seen here; its position is carried from a neighbouring sighting.
  readonly inferred: boolean;
}

export interface OverlayIndex {
  readonly frameSize: { readonly w: number; readonly h: number };
  readonly fps: number;
  readonly frames: number;
  readonly entities: readonly Entity[];
  shapesAt(frameIndex: number): readonly Shape[];
}

export function buildOverlayIndex(payload: TracksPayload): OverlayIndex {
  const byFrame = new Map<number, Array<{ entityId: string; record: MaskRecord }>>();
  for (const [entityId, records] of Object.entries(payload.tracks)) {
    for (const record of records) {
      const list = byFrame.get(record.frameIndex) ?? [];
      list.push({ entityId, record });
      byFrame.set(record.frameIndex, list);
    }
  }
  const cache = new Map<number, Shape[]>();
  return {
    frameSize: payload.frameSize,
    fps: payload.fps,
    frames: payload.frames,
    entities: payload.entities,
    shapesAt(frameIndex) {
      const cached = cache.get(frameIndex);
      if (cached) return cached;
      const shapes: Shape[] = [];
      for (const { entityId, record } of byFrame.get(frameIndex) ?? []) {
        const d = decodeMaskToSVGPath(record.mask);
        if (d === "") continue;
        shapes.push({ entityId, path: new Path2D(d), left: record.bounds.left, top: record.bounds.top, inferred: record.inferred === true });
      }
      cache.set(frameIndex, shapes);
      return shapes;
    },
  };
}

function isHand(e: Entity): boolean {
  return e.class === "bare_hand" || e.class === "gloved_hand";
}

// State replay lives in the engine (tested there); the overlay only draws it.
export { contaminatedAt as contaminationAt, recentlyContaminated as pulsingAt } from "../../engine/propagation.ts";

export type { Analysis, PropagationResult };

export interface DrawOptions {
  readonly glow: boolean;
  readonly contaminated: ReadonlySet<string>;
  readonly pulsing: ReadonlySet<string>;
  readonly highlight: string | null;
  readonly entities: ReadonlyMap<string, Entity>;
}

export function drawFrame(ctx: CanvasRenderingContext2D, shapes: readonly Shape[], options: DrawOptions): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const shape of shapes) {
    const entity = options.entities.get(shape.entityId);
    const hand = entity !== undefined && isHand(entity);
    const hot = options.glow && options.contaminated.has(shape.entityId);
    const pulse = hot && options.pulsing.has(shape.entityId);
    const highlighted = options.highlight === shape.entityId;
    ctx.save();
    ctx.translate(shape.left, shape.top);
    // Inferred positions are drawn dashed and lighter: the camera did not see the object here.
    if (shape.inferred) {
      ctx.setLineDash([6, 6]);
      ctx.globalAlpha = 0.6;
    }
    if (hot) {
      ctx.shadowColor = pulse ? "rgba(255, 200, 80, 1)" : "rgba(255, 130, 20, 0.95)";
      ctx.shadowBlur = pulse ? 46 : 24;
      ctx.fillStyle = pulse ? "rgba(255, 185, 60, 0.78)" : "rgba(255, 120, 10, 0.46)";
      ctx.fill(shape.path);
      ctx.shadowBlur = 0;
      ctx.lineWidth = highlighted ? 4 : 2;
      ctx.strokeStyle = "rgba(255, 220, 160, 0.95)";
      ctx.stroke(shape.path);
    } else {
      ctx.lineWidth = highlighted ? 4 : 1.5;
      ctx.strokeStyle = highlighted
        ? "rgba(255, 255, 255, 0.95)"
        : hand
          ? "rgba(0, 229, 255, 0.7)"
          : "rgba(255, 255, 255, 0.38)";
      ctx.stroke(shape.path);
    }
    ctx.restore();
  }
}
