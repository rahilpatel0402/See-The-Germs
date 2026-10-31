import { useEffect, useState } from "react";
import { api, type SessionReport } from "./api.ts";

interface Props {
  readonly clips: readonly string[];
  // Clips with a cached analysis. Only these can join a session; the rest are listed unchecked.
  readonly analyzed: readonly string[];
  // Titles by clip id, for the pick list and the table; ids are shown when no title exists.
  readonly titles: Readonly<Record<string, string>>;
  readonly onOpenClip: (clipId: string) => void;
  readonly onClose: () => void;
}

const pct = (rate: number | null): string => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);

// The infection preventionist's view: several clips as one session (a shift, a training
// cycle), compliance by Moment and caregiver, surfaces that keep getting contaminated, and a
// before-and-after compare of any two clips. Everything comes from cached analyses.
export function Session({ clips, analyzed, titles, onOpenClip, onClose }: Props) {
  const nameOf = (id: string): string => titles[id] || id;
  const [selected, setSelected] = useState<string[]>(clips.filter((id) => analyzed.includes(id)));
  const [report, setReport] = useState<SessionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<string>("");
  const [after, setAfter] = useState<string>("");

  // The clip list can arrive after the panel opens (deep link); start with every analyzed clip
  // selected. A clip that stopped before analysis would make the report request fail.
  useEffect(() => {
    setSelected((prev) => (prev.length === 0 ? clips.filter((id) => analyzed.includes(id)) : prev.filter((id) => analyzed.includes(id))));
  }, [clips, analyzed]);

  useEffect(() => {
    if (selected.length === 0) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    api
      .session(selected)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const row = (id: string) => report?.clips.find((c) => c.clipId === id);
  const b = before ? row(before) : undefined;
  const a = after ? row(after) : undefined;

  return (
    <div className="session-panel" role="dialog" aria-label="session report">
      <div className="upload-head">
        <h2>Session report</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">A session is any set of analyzed clips: one shift, one caregiver before and after coaching, one unit this week. Numbers come from the cached analyses; nothing is recomputed.</p>

      <div className="session-pick">
        {clips.map((id) =>
          analyzed.includes(id) ? (
            <label key={id}>
              <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} /> {nameOf(id)}
            </label>
          ) : (
            <label key={id} className="muted" title="Finish processing this clip to include it">
              <input type="checkbox" checked={false} disabled /> {nameOf(id)} (not analyzed yet)
            </label>
          ),
        )}
        {selected.length > 0 ? (
          <a className="link" href={api.sessionCsvUrl(selected)} download>
            Download opportunities CSV
          </a>
        ) : null}
      </div>

      {busy ? <p className="status">Loading...</p> : null}
      {error ? <p className="status error">{error}</p> : null}

      {report ? (
        <>
          <table className="session-table">
            <thead>
              <tr>
                <th>Clip</th>
                <th>Pathogen</th>
                <th>Compliance</th>
                <th>M1</th>
                <th>M2</th>
                <th>M4</th>
                <th>M5</th>
                <th>Rubs ok</th>
                <th>Glove issues</th>
                <th>Exposures</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {report.clips.map((c) => (
                <tr key={c.clipId}>
                  <td>
                    <button type="button" className="link" onClick={() => onOpenClip(c.clipId)}>
                      {nameOf(c.clipId)}
                    </button>
                  </td>
                  <td>{c.pathogen}</td>
                  <td>
                    {pct(c.compliance.overall.rate)} ({c.compliance.overall.met}/{c.compliance.overall.opportunities})
                  </td>
                  <td>{pct(c.compliance.byMoment["1"].rate)}</td>
                  <td>{pct(c.compliance.byMoment["2"].rate)}</td>
                  <td>{pct(c.compliance.byMoment["4"].rate)}</td>
                  <td>{pct(c.compliance.byMoment["5"].rate)}</td>
                  <td>
                    {c.hygiene.effective}/{c.hygiene.events}
                  </td>
                  <td>{c.gloveIssues.length}</td>
                  <td>{c.residentExposures}</td>
                  <td>{c.score.score}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Session</td>
                <td></td>
                <td>
                  {pct(report.session.overall.rate)} ({report.session.overall.met}/{report.session.overall.opportunities})
                </td>
                <td>{pct(report.session.byMoment["1"].rate)}</td>
                <td>{pct(report.session.byMoment["2"].rate)}</td>
                <td>{pct(report.session.byMoment["4"].rate)}</td>
                <td>{pct(report.session.byMoment["5"].rate)}</td>
                <td>{report.clips.reduce((n, c) => n + c.hygiene.effective, 0)}/{report.clips.reduce((n, c) => n + c.hygiene.events, 0)}</td>
                <td>{report.clips.reduce((n, c) => n + c.gloveIssues.length, 0)}</td>
                <td>{report.clips.reduce((n, c) => n + c.residentExposures, 0)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>

          <div className="session-columns">
            <section>
              <h3>By caregiver</h3>
              <ul className="plain">
                {Object.entries(report.session.byPerson).map(([p, c]) => (
                  <li key={p}>
                    {p}: {pct(c.rate)} ({c.met}/{c.opportunities})
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>Surfaces that keep getting contaminated</h3>
              {report.surfaces.every((s) => s.contacts === 0) ? (
                <p className="muted">None.</p>
              ) : (
                <ol className="chain">
                  {report.surfaces.filter((s) => s.contacts > 0).map((s) => (
                    <li key={s.label}>
                      {s.label}: {s.contacts} contact{s.contacts === 1 ? "" : "s"} while contaminated across {s.clips} clip{s.clips === 1 ? "" : "s"}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section>
            <h3>Before and after</h3>
            <p className="muted">Pick two clips, for example the same caregiver before and after a coaching note.</p>
            <div className="mark-row">
              <select value={before} onChange={(e) => setBefore(e.target.value)}>
                <option value="">before...</option>
                {report.clips.map((c) => (
                  <option key={c.clipId} value={c.clipId}>
                    {nameOf(c.clipId)}
                  </option>
                ))}
              </select>
              <select value={after} onChange={(e) => setAfter(e.target.value)}>
                <option value="">after...</option>
                {report.clips.map((c) => (
                  <option key={c.clipId} value={c.clipId}>
                    {nameOf(c.clipId)}
                  </option>
                ))}
              </select>
            </div>
            {b && a ? (
              <table className="session-table compare">
                <thead>
                  <tr>
                    <th></th>
                    <th>{nameOf(b.clipId)}</th>
                    <th>{nameOf(a.clipId)}</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  <CompareRow label="Hand hygiene compliance" before={b.compliance.overall.rate} after={a.compliance.overall.rate} format={pct} higherIsBetter />
                  <CompareRow label="Moments missed" before={b.momentMisses.length} after={a.momentMisses.length} format={String} />
                  <CompareRow label="Glove issues" before={b.gloveIssues.length} after={a.gloveIssues.length} format={String} />
                  <CompareRow label="Resident exposures" before={b.residentExposures} after={a.residentExposures} format={String} />
                  <CompareRow label="Contaminated surfaces" before={b.score.contaminatedSurfaces} after={a.score.contaminatedSurfaces} format={String} />
                  <CompareRow label="Exposure score" before={b.score.score} after={a.score.score} format={String} />
                </tbody>
              </table>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function CompareRow({ label, before, after, format, higherIsBetter = false }: { label: string; before: number | null; after: number | null; format: (v: number | null) => string; higherIsBetter?: boolean }) {
  const delta = before === null || after === null ? null : after - before;
  const better = delta === null ? null : higherIsBetter ? delta > 0 : delta < 0;
  const same = delta === 0;
  return (
    <tr>
      <td>{label}</td>
      <td>{format(before)}</td>
      <td>{format(after)}</td>
      <td className={same ? "muted" : better ? "ok" : "warn"}>{delta === null ? "n/a" : same ? "no change" : higherIsBetter ? `${delta > 0 ? "+" : ""}${Math.round(delta * 100)} points` : `${delta > 0 ? "+" : ""}${delta}`}</td>
    </tr>
  );
}
