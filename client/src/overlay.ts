// Overlay geometry and state replay. No React here. Masks are decoded once per frame on first
// use and cached as Path2D; contamination at time t is replayed from the analysis changes, so
// the same analysis and the same t always draw the same pixels.
import { decodeMaskToSVGPath } from "@meta-sam/parser";
import { isHand } from "../../engine/gloves.ts";
import type { Analysis, Entity, MaskRecord, PropagationResult } from "../../engine/types.ts";
import type { TracksPayload } from "./api.ts";

export interface Shape {
  readonly entityId: string;
  readonly path: Path2D;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
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
        shapes.push({ entityId, path: new Path2D(d), left: record.bounds.left, top: record.bounds.top, right: record.bounds.right, bottom: record.bounds.bottom, inferred: record.inferred === true });
      }
      cache.set(frameIndex, shapes);
      return shapes;
    },
  };
}

// State replay lives in the engine (tested there); the overlay only draws it.
export { contaminatedAt as contaminationAt, contaminatedDurationsAt, recentlyContaminated as pulsingAt } from "../../engine/propagation.ts";

export type { Analysis, PropagationResult };

export type OverlayMode = "off" | "glow" | "heat";

export interface DrawOptions {
  readonly mode: OverlayMode;
  readonly contaminated: ReadonlySet<string>;
  readonly pulsing: ReadonlySet<string>;
  // Heat mode: fraction of elapsed time each entity has been contaminated, 0 to 1.
  readonly heat: ReadonlyMap<string, number>;
  readonly highlight: string | null;
  readonly entities: ReadonlyMap<string, Entity>;
}

// The rub countdown drawn near the hand during a hygiene event: seconds rubbed over the WHO
// minimum, green once met, red if the next touch came early.
export function drawRubTimer(
  ctx: CanvasRenderingContext2D,
  shapes: readonly Shape[],
  handIds: ReadonlySet<string>,
  elapsedS: number,
  requiredS: number,
  endedEarly: boolean,
): void {
  const hand = shapes.find((s) => handIds.has(s.entityId));
  const x = hand ? (hand.left + hand.right) / 2 : ctx.canvas.width / 2;
  const y = hand ? Math.max(40, hand.top - 16) : 60;
  const done = elapsedS >= requiredS;
  const label = `${Math.min(elapsedS, requiredS).toFixed(0)} / ${requiredS} s rub`;
  ctx.save();
  ctx.font = `bold ${Math.round(ctx.canvas.width / 32)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(label).width + 28;
  const h = Math.round(ctx.canvas.width / 20);
  ctx.fillStyle = endedEarly ? "rgba(180, 30, 30, 0.9)" : done ? "rgba(20, 140, 70, 0.9)" : "rgba(20, 20, 20, 0.8)";
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(endedEarly ? `${label}, touched early` : label, x, y);
  ctx.restore();
}

export function drawFrame(ctx: CanvasRenderingContext2D, shapes: readonly Shape[], options: DrawOptions): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const shape of shapes) {
    const entity = options.entities.get(shape.entityId);
    const hand = entity !== undefined && isHand(entity);
    const hot = options.mode !== "off" && options.contaminated.has(shape.entityId);
    const pulse = hot && options.pulsing.has(shape.entityId);
    const highlighted = options.highlight === shape.entityId;
    ctx.save();
    ctx.translate(shape.left, shape.top);
    // Inferred positions are drawn dashed and lighter: the camera did not see the object here.
    if (shape.inferred) {
      ctx.setLineDash([6, 6]);
      ctx.globalAlpha = 0.6;
    }
    if (options.mode === "heat" && (hot || (options.heat.get(shape.entityId) ?? 0) > 0)) {
      // Heat: how long this has been dirty relative to the clip so far. Cool amber to deep red.
      const h = Math.min(1, options.heat.get(shape.entityId) ?? 0);
      const r = 255;
      const g = Math.round(170 - 150 * h);
      const b = Math.round(60 - 50 * h);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.25 + 0.55 * h})`;
      ctx.fill(shape.path);
      ctx.lineWidth = highlighted ? 4 : 1.5;
      ctx.strokeStyle = `rgba(255, ${g}, ${b}, 0.95)`;
      ctx.stroke(shape.path);
    } else if (hot) {
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
