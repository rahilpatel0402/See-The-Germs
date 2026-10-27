import type { Analysis } from "../../engine/types.ts";
import { SCORE_WEIGHTS } from "../../engine/config.ts";

interface Props {
  readonly analysis: Analysis | null;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSeek: (t: number) => void;
  readonly onHover: (entityId: string | null) => void;
}

const fmt = (t: number): string => `${t.toFixed(1)} s`;

export function Drawer({ analysis, open, onToggle, onSeek, onHover }: Props) {
  const labels = new Map((analysis?.entities ?? []).map((e) => [e.id, e.label]));
  const name = (id: string): string => labels.get(id) ?? id;
  return (
    <aside className={`drawer${open ? " open" : ""}`}>
      <button type="button" className="drawer-toggle" onClick={onToggle} aria-expanded={open}>
        {open ? "Hide details" : "Details"}
      </button>
      {open && analysis ? (
        <div className="drawer-body">
          <section>
            <h2>Exposure score</h2>
            <p className="score">{analysis.score.score}</p>
            <ul className="plain">
              <li>Contaminated surfaces: {analysis.score.contaminatedSurfaces}</li>
              <li>Chain length: {analysis.score.chainLength} transfers</li>
              <li>
                Resident exposures:{" "}
                {Object.entries(analysis.score.residentExposures).map(([id, n]) => `${name(id)} ${n}`).join(", ") || "none"}
              </li>
              <li>
                Moments missed: {analysis.momentMisses.length}
                {analysis.momentMisses.length > 0
                  ? ` (${Object.entries(analysis.score.momentsMissed).filter(([, n]) => n > 0).map(([m, n]) => `M${m}: ${n}`).join(", ")})`
                  : ""}
              </li>
            </ul>
            <p className="muted">
              Heuristic: {SCORE_WEIGHTS.residentExposure} per resident exposure, {SCORE_WEIGHTS.contaminatedSurface} per surface,{" "}
              {SCORE_WEIGHTS.momentMiss} per missed moment. Not a validated instrument.
            </p>
          </section>

          <section>
            <h2>Chain</h2>
            {analysis.propagation.transfers.length === 0 ? (
              <p className="muted">Nothing spread beyond the source.</p>
            ) : (
              <ol className="chain">
                {analysis.propagation.transfers.map((e, i) => (
                  <li key={i}>
                    <button type="button" className="link" onClick={() => onSeek(e.t)} onMouseEnter={() => onHover(e.toId)} onMouseLeave={() => onHover(null)}>
                      {fmt(e.t)}
                    </button>{" "}
                    {name(e.fromId)} to {name(e.toId)}
                  </li>
                ))}
              </ol>
            )}
            {analysis.propagation.residentExposures.length > 0 ? (
              <p>
                Resident exposures:{" "}
                {analysis.propagation.residentExposures.map((x, i) => (
                  <span key={i}>
                    {i > 0 ? ", " : ""}
                    {name(x.residentId)} at {fmt(x.t)}
                  </span>
                ))}
              </p>
            ) : null}
          </section>

          <section>
            <h2>Five Moments</h2>
            {analysis.momentMisses.length === 0 ? (
              <p className="muted">No missed moments detected in this clip.</p>
            ) : (
              <ul className="plain">
                {analysis.momentMisses.map((m, i) => (
                  <li key={i}>
                    <button type="button" className="link" onClick={() => onSeek(m.t)}>
                      {fmt(m.t)}
                    </button>{" "}
                    Moment {m.moment}: {MOMENT_TEXT[m.moment]} ({name(m.handId)}).
                    {m.downstream.length > 0 ? <span className="muted"> Hygiene here would have kept clean: {m.downstream.map(name).join(", ")}.</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">Moment 3 (after body fluid exposure) is out of scope for this version.</p>
          </section>

          <section>
            <h2>Pathogen</h2>
            <p>
              <strong>{analysis.pathogen.label}.</strong> {analysis.pathogen.uiNote}
            </p>
            {analysis.hygieneEvents.some((h) => !h.effective) ? (
              <p className="warn">A hygiene event in this clip used an agent that does not clear {analysis.pathogen.label} from hands.</p>
            ) : null}
          </section>

          {analysis.adjudications.length > 0 ? (
            <section>
              <h2>Vision reviewed</h2>
              <ul className="plain">
                {analysis.adjudications.map((a) => (
                  <li key={a.candidateId}>
                    <strong>{a.verdict.replace("_", " ")}</strong>: {a.reasoning}
                  </li>
                ))}
              </ul>
              <p className="muted">Muse Spark voted only on these perception edge cases. The engine decided everything else.</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

const MOMENT_TEXT: Record<1 | 2 | 4 | 5, string> = {
  1: "before touching a resident",
  2: "before a clean or aseptic task",
  4: "after touching a resident",
  5: "after touching the resident's surroundings",
};
