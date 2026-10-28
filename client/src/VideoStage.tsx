import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { Analysis, MaskBounds, PropagationResult } from "../../engine/types.ts";
import { HYGIENE_CONFIG } from "../../engine/config.ts";
import { contaminatedDurationsAt, contaminationAt, drawFrame, drawRubTimer, pulsingAt, type OverlayIndex, type OverlayMode } from "./overlay.ts";

const PULSE_WINDOW_S = 0.4;

interface Props {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly src: string;
  readonly analysis: Analysis | null;
  // When set, the overlay draws this propagation instead of the analysis's own (counterfactual).
  readonly propagation: PropagationResult | null;
  readonly index: OverlayIndex | null;
  readonly mode: OverlayMode;
  readonly highlight: string | null;
  // Mark mode: the video is paused and a drag on the picture draws a box in video pixels.
  readonly marking: boolean;
  readonly onBox: (box: MaskBounds, frameIndex: number) => void;
  readonly onTime: (t: number) => void;
  readonly onDuration: (d: number) => void;
}

// Maps a pointer position on the element to video pixels, accounting for object-fit: contain.
function toVideoPixels(video: HTMLVideoElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || rect.width === 0 || rect.height === 0) return null;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const shownW = vw * scale;
  const shownH = vh * scale;
  const offX = rect.left + (rect.width - shownW) / 2;
  const offY = rect.top + (rect.height - shownH) / 2;
  const x = Math.max(0, Math.min(vw, (clientX - offX) / scale));
  const y = Math.max(0, Math.min(vh, (clientY - offY) / scale));
  return { x, y };
}

export function VideoStage({ videoRef, src, analysis, propagation, index, mode, highlight, marking, onBox, onTime, onDuration }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const entities = useMemo(() => new Map((index?.entities ?? []).map((e) => [e.id, e])), [index]);
  const active = propagation ?? analysis?.propagation ?? null;
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !index) return;
    canvas.width = index.frameSize.w;
    canvas.height = index.frameSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastKey = "";
    const tick = () => {
      const t = video.currentTime;
      const frameIndex = Math.min(index.frames - 1, Math.max(0, Math.floor(t * index.fps + 1e-6)));
      const d = dragRef.current;
      const key = `${frameIndex}|${mode}|${highlight ?? ""}|${Math.floor(t * 10)}|${d ? `${d.x0},${d.y0},${d.x1},${d.y1}` : ""}`;
      if (key !== lastKey) {
        lastKey = key;
        const shapes = index.shapesAt(frameIndex);
        const list = analysis?.entities ?? [];
        const heat = new Map<string, number>();
        if (active && mode === "heat" && t > 0) {
          for (const [id, seconds] of contaminatedDurationsAt(list, active, t)) heat.set(id, seconds / t);
        }
        drawFrame(ctx, shapes, {
          mode,
          contaminated: active ? contaminationAt(list, active, t) : new Set(),
          pulsing: active ? pulsingAt(list, active, t, PULSE_WINDOW_S) : new Set(),
          heat,
          highlight,
          entities,
        });
        // Rub countdown during a hygiene event, for the whole required duration or until the
        // rub ended early (next touch), shown in red for a moment after an early end.
        if (analysis) {
          for (const h of analysis.hygieneEvents) {
            const required = HYGIENE_CONFIG.minRubS[h.agent];
            const shownUntil = h.adequate ? h.t + required : Math.min(h.t + required, h.t + h.durationS + 1.5);
            if (t >= h.t && t < shownUntil) {
              const handIds = new Set(list.filter((e) => (e.person ?? "P1") === (list.find((x) => x.id === h.handId)?.person ?? "P1") && (e.class === "bare_hand" || e.class === "gloved_hand")).map((e) => e.id));
              drawRubTimer(ctx, shapes, handIds, Math.min(t - h.t, h.durationS), required, !h.adequate && t - h.t >= h.durationS);
              break;
            }
          }
        }
        if (d) {
          ctx.save();
          ctx.setLineDash([8, 6]);
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#ff00c8";
          ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
          ctx.restore();
        }
        onTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, index, analysis, active, mode, highlight, entities, onTime]);

  useEffect(() => {
    if (marking) videoRef.current?.pause();
    else setDrag(null);
  }, [marking, videoRef]);

  const pointer = (e: PointerEvent<HTMLCanvasElement>) => {
    const video = videoRef.current;
    if (!video) return null;
    return toVideoPixels(video, e.clientX, e.clientY);
  };

  return (
    <div className={`stage${marking ? " marking" : ""}`}>
      <video ref={videoRef} src={src} controls={!marking} playsInline preload="auto" onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)} />
      <canvas
        ref={canvasRef}
        className="overlay"
        aria-hidden={!marking}
        onPointerDown={(e) => {
          if (!marking) return;
          const p = pointer(e);
          if (!p) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onPointerMove={(e) => {
          if (!marking || !drag) return;
          const p = pointer(e);
          if (p) setDrag({ ...drag, x1: p.x, y1: p.y });
        }}
        onPointerUp={(e) => {
          if (!marking || !drag) return;
          const p = pointer(e) ?? { x: drag.x1, y: drag.y1 };
          const box: MaskBounds = {
            left: Math.round(Math.min(drag.x0, p.x)),
            top: Math.round(Math.min(drag.y0, p.y)),
            right: Math.round(Math.max(drag.x0, p.x)),
            bottom: Math.round(Math.max(drag.y0, p.y)),
          };
          setDrag(null);
          const video = videoRef.current;
          if (video && index && box.right - box.left >= 4 && box.bottom - box.top >= 4) {
            onBox(box, Math.min(index.frames - 1, Math.max(0, Math.floor(video.currentTime * index.fps + 1e-6))));
          }
        }}
      />
      {marking ? <div className="mark-hint">Paused. Drag a box around the object on this frame. Use the arrow keys to change frame first.</div> : null}
    </div>
  );
}
