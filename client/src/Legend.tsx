import type { OverlayMode } from "./overlay.ts";

// What the colors on the stage and the timeline mean. Shown over the video, bottom left.
export function Legend({ mode }: { mode: OverlayMode }) {
  return (
    <div className="legend" aria-label="legend">
      {mode === "heat" ? (
        <span>
          <i className="sw heat" /> longer contaminated is darker
        </span>
      ) : (
        <span>
          <i className="sw hot" /> contaminated
        </span>
      )}
      <span>
        <i className="sw clean" /> clean
      </span>
      <span>
        <i className="sw inferred" /> position inferred, camera could not see it
      </span>
      <span>
        <i className="sw eye" /> vision reviewed
      </span>
      <span>
        <i className="sw tick-ok" /> hygiene counted
      </span>
      <span>
        <i className="sw tick-bad" /> hygiene short or wrong agent
      </span>
    </div>
  );
}
