import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { Analysis, PropagationResult } from "../../engine/types.ts";
import { contaminatedDurationsAt, contaminationAt, drawFrame, pulsingAt, type OverlayIndex, type OverlayMode } from "./overlay.ts";

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
  readonly onTime: (t: number) => void;
  readonly onDuration: (d: number) => void;
}

export function VideoStage({ videoRef, src, analysis, propagation, index, mode, highlight, onTime, onDuration }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const entities = useMemo(() => new Map((index?.entities ?? []).map((e) => [e.id, e])), [index]);
  const active = propagation ?? analysis?.propagation ?? null;

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
      // Pulse state changes within a frame, so include a coarse time bucket in the key.
      const key = `${frameIndex}|${mode}|${highlight ?? ""}|${Math.floor(t * 10)}`;
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
        onTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, index, analysis, active, mode, highlight, entities, onTime]);

  return (
    <div className="stage">
      <video ref={videoRef} src={src} controls playsInline preload="auto" onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)} />
      <canvas ref={canvasRef} className="overlay" aria-hidden="true" />
    </div>
  );
}
