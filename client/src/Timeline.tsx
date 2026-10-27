import { useMemo, type MouseEvent } from "react";
import type { Analysis } from "../../engine/types.ts";

interface Props {
  readonly analysis: Analysis | null;
  readonly duration: number;
  readonly currentTime: number;
  readonly onSeek: (t: number) => void;
  readonly onHover: (entityId: string | null) => void;
}

const fmt = (t: number): string => `${t.toFixed(1)} s`;

export function Timeline({ analysis, duration, currentTime, onSeek, onHover }: Props) {
  const labels = useMemo(() => new Map((analysis?.entities ?? []).map((e) => [e.id, e.label])), [analysis]);
  const name = (id: string): string => labels.get(id) ?? id;
  const pct = (t: number): string => `${duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0}%`;
  const width = (a: number, b: number): string => `${duration > 0 ? Math.max(0.4, ((b - a) / duration) * 100) : 0}%`;

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    if (duration > 0) onSeek((x / rect.width) * duration);
  };

  if (!analysis) {
    return <div className="timeline empty">No analysis yet.</div>;
  }

  const verdictFor = new Map(analysis.adjudications.map((a) => [a.candidateId, a]));
  const contactsSet = new Set(analysis.contacts.map((c) => `${c.handId}|${c.entityId}|${c.startT}`));
  const unreviewed = analysis.candidates.filter(
    (c) => c.confidence === "ambiguous" && !contactsSet.has(`${c.handId}|${c.entityId}|${c.startT}`),
  );

  return (
    <div className="timeline" onClick={seek} role="presentation">
      <div className="lane">
        <span className="lane-label">contacts</span>
        {analysis.contacts.map((c, i) => {
          // Contacts may be merged across hand classes, so match the reviewed candidate by overlap.
          const candidate = analysis.candidates.find(
            (k) => k.entityId === c.entityId && k.startT <= c.endT && k.endT >= c.startT && (!c.adjudicated || verdictFor.has(k.id)),
          );
          const verdict = candidate ? verdictFor.get(candidate.id) : undefined;
          return (
            <span
              key={`c${i}`}
              className={`item contact${c.adjudicated ? " reviewed" : ""}`}
              style={{ left: pct(c.startT), width: width(c.startT, c.endT) }}
              title={`${name(c.handId)} touches ${name(c.entityId)}, ${fmt(c.startT)} to ${fmt(c.endT)}${verdict ? `. Vision reviewed: ${verdict.verdict.replace("_", " ")}. ${verdict.reasoning}` : ""}`}
              onMouseEnter={() => onHover(c.entityId)}
              onMouseLeave={() => onHover(null)}
            >
              {c.adjudicated ? <i className="eye" aria-label="vision reviewed" /> : null}
            </span>
          );
        })}
        {unreviewed.map((c) => {
          const verdict = verdictFor.get(c.id);
          return (
            <span
              key={c.id}
              className="item ambiguous"
              style={{ left: pct(c.startT), width: width(c.startT, c.endT) }}
              title={`${name(c.handId)} near ${name(c.entityId)}, ${fmt(c.startT)} to ${fmt(c.endT)}: ${verdict ? `vision reviewed, ${verdict.verdict.replace("_", " ")}. ${verdict.reasoning}` : "ambiguous, not yet reviewed, not counted"}`}
            >
              {verdict ? <i className="eye" aria-label="vision reviewed" /> : null}
            </span>
          );
        })}
      </div>
      <div className="lane">
        <span className="lane-label">transfers</span>
        {analysis.propagation.transfers.map((e, i) => (
          <span key={`t${i}`} className="tick transfer" style={{ left: pct(e.t) }} title={`${fmt(e.t)}: ${name(e.fromId)} to ${name(e.toId)}`} onMouseEnter={() => onHover(e.toId)} onMouseLeave={() => onHover(null)} />
        ))}
      </div>
      <div className="lane">
        <span className="lane-label">hygiene, gloves</span>
        {analysis.hygieneEvents.map((h, i) => (
          <span key={`h${i}`} className={`tick hygiene ${h.effective ? "effective" : "ineffective"}`} style={{ left: pct(h.t) }} title={`${fmt(h.t)}: ${h.agent.replace("_", " ")}, ${h.effective ? "effective" : `not effective against ${analysis.pathogen.label}`}`} />
        ))}
        {analysis.gloveEvents.map((g, i) => (
          <span key={`g${i}`} className={`tick glove ${g.type}`} style={{ left: pct(g.t) }} title={`${fmt(g.t)}: glove ${g.type === "don" ? "on" : "off"} (${g.source})`}>
            {g.type === "don" ? "on" : "off"}
          </span>
        ))}
      </div>
      <div className="lane">
        <span className="lane-label">moments missed</span>
        {analysis.momentMisses.map((m, i) => (
          <span key={`m${i}`} className="tick moment" style={{ left: pct(m.t) }} title={`${fmt(m.t)}: Moment ${m.moment} missed by ${name(m.handId)}. Downstream: ${m.downstream.map(name).join(", ") || "none"}`}>
            {m.moment}
          </span>
        ))}
      </div>
      <div className="cursor" style={{ left: pct(currentTime) }} />
    </div>
  );
}
