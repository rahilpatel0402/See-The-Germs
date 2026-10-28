import { useState } from "react";
import type { Analysis, Narrative } from "../../engine/types.ts";
import { SCORE_WEIGHTS } from "../../engine/config.ts";
import { ChainGraph } from "./ChainGraph.tsx";

interface Props {
  readonly analysis: Analysis | null;
  readonly narrative: Narrative | null;
  readonly narrativeState: "idle" | "loading" | "error" | "ready";
  readonly narrativeError: string | null;
  readonly onNarrate: () => void;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSeek: (t: number) => void;
  readonly onHover: (entityId: string | null) => void;
}

const fmt = (t: number): string => `${t.toFixed(1)} s`;
const pct = (rate: number | null): string => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);

const GLOVE_ISSUE_TEXT: Record<string, string> = {
  no_hygiene_before_don: "gloves put on without hand hygiene first",
  no_hygiene_after_doff: "no hand hygiene after taking gloves off",
  glove_across_residents: "one pair of gloves used across two residents",
  gloved_healthcare_area_contact: "gloved hand touched a healthcare-area object",
};

export function Drawer({ analysis, narrative, narrativeState, narrativeError, onNarrate, open, onToggle, onSeek, onHover }: Props) {
  const [copied, setCopied] = useState(false);
  const labels = new Map((analysis?.entities ?? []).map((e) => [e.id, e.label]));
  const name = (id: string): string => labels.get(id) ?? id;

  const cleaningText = (): string => {
    if (!analysis) return "";
    const lines = [
      `Disinfect before next use (${analysis.pathogen.label}, staged training clip ${analysis.clipId}):`,
      ...analysis.cleaning.items.map((i, n) => `${n + 1}. ${i.label}${i.isSource ? " (source)" : ""}: ${i.contactCount} contact${i.contactCount === 1 ? "" : "s"} while contaminated, from ${fmt(i.firstContaminatedT)}`),
      analysis.cleaning.disinfectantNote,
    ];
    return lines.join("\n");
  };

  return (
    <aside className={`drawer${open ? " open" : ""}`}>
      <button type="button" className="drawer-toggle" onClick={onToggle} aria-expanded={open}>
        {open ? "Hide details" : "Details"}
      </button>
      {open && analysis ? (
        <div className="drawer-body">
          <section>
            <h2>Coaching note</h2>
            {narrative ? (
              <p className="prose">{narrative.coaching_note}</p>
            ) : narrativeState === "loading" ? (
              <p className="muted">Writing...</p>
            ) : (
              <p className="muted">
                {narrativeState === "error" ? `Narrative unavailable: ${narrativeError ?? "unknown error"}. The structured panels below are the analysis.` : "Not written yet."}{" "}
                <button type="button" className="link" onClick={onNarrate}>
                  {narrativeState === "error" ? "Try again" : "Write it"}
                </button>
              </p>
            )}
          </section>

          <section>
            <h2>Hand hygiene compliance</h2>
            <table className="compliance">
              <thead>
                <tr>
                  <th>Moment</th>
                  <th>Opportunities</th>
                  <th>Met</th>
                  <th>Rate</th>
                </tr>
              </thead>
              <tbody>
                {(["1", "2", "4", "5"] as const).map((m) => (
                  <tr key={m}>
                    <td>{m}</td>
                    <td>{analysis.compliance.byMoment[m].opportunities}</td>
                    <td>{analysis.compliance.byMoment[m].met}</td>
                    <td>{pct(analysis.compliance.byMoment[m].rate)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>All</td>
                  <td>{analysis.compliance.overall.opportunities}</td>
                  <td>{analysis.compliance.overall.met}</td>
                  <td>{pct(analysis.compliance.overall.rate)}</td>
                </tr>
              </tbody>
            </table>
            <p className="muted">Met over opportunities, the WHO observation form figure. Moment 3 is out of scope.</p>
          </section>

          <section>
            <h2>Hand hygiene events</h2>
            {analysis.hygieneEvents.length === 0 ? (
              <p className="muted">No hand hygiene in this clip.</p>
            ) : (
              <ul className="plain">
                {analysis.hygieneEvents.map((h, i) => (
                  <li key={i}>
                    <button type="button" className="link" onClick={() => onSeek(h.t)}>
                      {fmt(h.t)}
                    </button>{" "}
                    {h.agent === "alcohol_rub" ? "alcohol rub" : "soap and water"}, {Number.isFinite(h.durationS) ? `${h.durationS.toFixed(0)} s` : "to the end of the clip"}.{" "}
                    {h.effective ? (
                      <span className="ok">Counted.</span>
                    ) : !h.adequate ? (
                      <span className="warn">Too short: WHO calls for {h.agent === "alcohol_rub" ? "20 to 30" : "40 to 60"} seconds.</span>
                    ) : (
                      <span className="warn">Does not clear {analysis.pathogen.label}.</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {analysis.gloveEvents.length > 0 || analysis.gloveIssues.length > 0 ? (
            <section>
              <h2>Glove use</h2>
              <ul className="plain">
                {analysis.gloveEvents.map((g, i) => (
                  <li key={`e${i}`}>
                    <button type="button" className="link" onClick={() => onSeek(g.t)}>
                      {fmt(g.t)}
                    </button>{" "}
                    glove {g.type === "don" ? "on" : "off"} ({g.source}).
                  </li>
                ))}
                {analysis.gloveIssues.map((x, i) => (
                  <li key={`i${i}`} className="warn">
                    <button type="button" className="link" onClick={() => onSeek(x.t)}>
                      {fmt(x.t)}
                    </button>{" "}
                    {GLOVE_ISSUE_TEXT[x.type] ?? x.type}: {x.entityIds.map(name).join(", ")}.
                  </li>
                ))}
              </ul>
              <p className="muted">Gloves do not replace hand hygiene (WHO glove use leaflet, CDC hand hygiene guidance).</p>
            </section>
          ) : null}

          <section>
            <h2>Exposure score</h2>
            <p className="score">{analysis.score.score}</p>
            <ul className="plain">
              <li>Contaminated surfaces: {analysis.score.contaminatedSurfaces}</li>
              <li>Chain length: {analysis.score.chainLength} transfers</li>
              <li>Resident exposures: {Object.entries(analysis.score.residentExposures).map(([id, n]) => `${name(id)} ${n}`).join(", ") || "none"}</li>
              <li>
                Moments missed: {analysis.momentMisses.length}
                {analysis.momentMisses.length > 0
                  ? ` (${Object.entries(analysis.score.momentsMissed).filter(([, n]) => n > 0).map(([m, n]) => `M${m}: ${n}`).join(", ")})`
                  : ""}
              </li>
            </ul>
            <p className="muted">
              Heuristic: {SCORE_WEIGHTS.residentExposure} per resident exposure, {SCORE_WEIGHTS.contaminatedSurface} per surface, {SCORE_WEIGHTS.momentMiss} per missed moment. Not a validated instrument.
            </p>
          </section>

          <section>
            <h2>Chain</h2>
            {analysis.propagation.transfers.length === 0 ? (
              <p className="muted">Nothing spread beyond the source.</p>
            ) : (
              <ChainGraph analysis={analysis} onSeek={onSeek} onHover={onHover} />
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
          </section>

          <section>
            <h2>Disinfect before next use</h2>
            {analysis.cleaning.items.length === 0 ? (
              <p className="muted">Nothing contaminated.</p>
            ) : (
              <ol className="chain">
                {analysis.cleaning.items.map((i) => (
                  <li key={i.entityId} onMouseEnter={() => onHover(i.entityId)} onMouseLeave={() => onHover(null)}>
                    {i.label}
                    {i.isSource ? " (source)" : ""}: {i.contactCount} contact{i.contactCount === 1 ? "" : "s"} while contaminated
                  </li>
                ))}
              </ol>
            )}
            <p className="muted">{analysis.cleaning.disinfectantNote}</p>
            <button
              type="button"
              className="link"
              onClick={() => {
                void navigator.clipboard?.writeText(cleaningText()).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy list for housekeeping"}
            </button>
          </section>

          <section>
            <h2>Audit summary</h2>
            {narrative ? <p className="prose">{narrative.audit_summary}</p> : <p className="muted">Written together with the coaching note.</p>}
          </section>

          <section>
            <h2>Pathogen</h2>
            <p>
              <strong>{analysis.pathogen.label}.</strong> {analysis.pathogen.uiNote}
            </p>
          </section>

          <section>
            <h2>What this does not do</h2>
            <ul className="plain muted">
              <li>Contact is a 2D overlap heuristic from a fixed camera. Hovers that look like touches, and contacts on an object the camera could not see, go to vision review; the review is capped and fallible, and every reviewed contact is marked.</li>
              <li>Rub duration is measured from reaching the dispenser to the next touch, not from watching the hands.</li>
              <li>Glove removal technique is not visible, so the bare hand is assumed exposed on doff.</li>
              <li>Moment 3 (after body fluid exposure) is out of scope. The score weights are a heuristic.</li>
              <li>Staged synthetic footage only. No diagnosis, no treatment, no advice about any person.</li>
            </ul>
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
