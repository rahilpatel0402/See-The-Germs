import { useMemo, useState, type MouseEvent } from "react";
import type { Adjudication, Analysis, ContactCandidate } from "../../engine/types.ts";

interface Props {
  readonly clipId: string | null;
  readonly analysis: Analysis | null;
  readonly duration: number;
  readonly currentTime: number;
  readonly onSeek: (t: number) => void;
  readonly onHover: (entityId: string | null) => void;
}

const fmt = (t: number): string => `${t.toFixed(1)} s`;

interface ReviewCard {
  readonly candidate: ContactCandidate;
  readonly verdict: Adjudication;
  readonly leftPct: number;
}

export function Timeline({ clipId, analysis, duration, currentTime, onSeek, onHover }: Props) {
  const labels = useMemo(() => new Map((analysis?.entities ?? []).map((e) => [e.id, e.label])), [analysis]);
  const [card, setCard] = useState<ReviewCard | null>(null);
  const name = (id: string): string => labels.get(id) ?? id;
  const pctNumber = (t: number): number => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);
  const pct = (t: number): string => `${pctNumber(t)}%`;
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
  const candidateById = new Map(analysis.candidates.map((c) => [c.id, c]));
  // Candidates already represented by a contact (confident, or ambiguous with a touching or
  // unclear verdict). Everything else ambiguous is drawn as not counted.
  const covered = new Set(analysis.contacts.flatMap((c) => c.candidateIds ?? []));
  const unreviewed = analysis.candidates.filter((c) => c.confidence === "ambiguous" && !covered.has(c.id));
  const frameUrl = (candidateId: string, n: 1 | 2): string =>
    `/api/clips/${encodeURIComponent(clipId ?? "")}/adjudication/${encodeURIComponent(candidateId.replace(/[^A-Za-z0-9_-]/g, "_"))}/${n}.png`;

  const eye = (candidate: ContactCandidate | undefined, verdict: Adjudication | undefined, leftT: number) =>
    candidate && verdict ? (
      <i
        className="eye"
        aria-label="vision reviewed"
        onMouseEnter={() => setCard({ candidate, verdict, leftPct: pctNumber(leftT) })}
        onMouseLeave={() => setCard(null)}
      />
    ) : null;

  return (
    <div className="timeline-wrap">
      <div className="timeline" onClick={seek} role="presentation">
        <div className="lane">
          <span className="lane-label">contacts</span>
          {analysis.contacts.map((c, i) => {
            // The reviewed candidate behind this contact, if any (ids travel with the contact).
            const reviewedId = (c.candidateIds ?? []).find((id) => verdictFor.has(id));
            const candidate = reviewedId ? candidateById.get(reviewedId) : undefined;
            const verdict = reviewedId ? verdictFor.get(reviewedId) : undefined;
            return (
              <span
                key={`c${i}`}
                className={`item contact${c.adjudicated ? " reviewed" : ""}`}
                style={{ left: pct(c.startT), width: width(c.startT, c.endT) }}
                title={`${name(c.handId)} touches ${name(c.entityId)}, ${fmt(c.startT)} to ${fmt(c.endT)}${verdict ? `. Vision reviewed: ${verdict.verdict.replace("_", " ")}.` : ""}`}
                onMouseEnter={() => onHover(c.entityId)}
                onMouseLeave={() => onHover(null)}
              >
                {c.adjudicated ? eye(candidate, verdict, c.startT) : null}
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
                title={`${name(c.handId)} near ${name(c.entityId)}, ${fmt(c.startT)} to ${fmt(c.endT)}: ${verdict ? `vision reviewed, ${verdict.verdict.replace("_", " ")}.` : "ambiguous, not yet reviewed, not counted"}`}
              >
                {eye(c, verdict, c.startT)}
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
            <span
              key={`h${i}`}
              className={`tick hygiene ${h.effective ? "effective" : "ineffective"}`}
              style={{ left: pct(h.t) }}
              title={`${fmt(h.t)}: ${h.agent.replace("_", " ")}, ${Number.isFinite(h.durationS) ? `${h.durationS.toFixed(0)} s` : "to the end"}. ${
                h.effective ? "Counted." : !h.adequate ? `Too short for WHO (${h.agent === "alcohol_rub" ? "20 to 30" : "40 to 60"} s).` : `Not effective against ${analysis.pathogen.label}.`
              }`}
            >
              {!h.adequate ? "short" : ""}
            </span>
          ))}
          {analysis.gloveEvents.map((g, i) => (
            <span key={`g${i}`} className={`tick glove ${g.type}`} style={{ left: pct(g.t) }} title={`${fmt(g.t)}: glove ${g.type === "don" ? "on" : "off"} (${g.source})`}>
              {g.type === "don" ? "on" : "off"}
            </span>
          ))}
          {analysis.gloveIssues.map((x, i) => (
            <span key={`gi${i}`} className="tick glove-issue" style={{ left: pct(x.t) }} title={`${fmt(x.t)}: glove use issue, ${x.type.replace(/_/g, " ")}: ${x.entityIds.map(name).join(", ")}`}>
              !
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
      {card ? (
        <div className="review-card" style={{ left: `min(max(0%, ${card.leftPct}% - 160px), calc(100% - 340px))` }}>
          <div className="review-frames">
            <img src={frameUrl(card.candidate.id, 1)} alt="first frame, hand and object outlined" />
            <img src={frameUrl(card.candidate.id, 2)} alt="middle frame, hand and object outlined" />
          </div>
          <p>
            <strong>Vision reviewed: {card.verdict.verdict.replace("_", " ")}.</strong> {card.verdict.reasoning}
          </p>
          <p className="muted">
            {name(card.candidate.handId)} near {name(card.candidate.entityId)}, {fmt(card.candidate.startT)} to {fmt(card.candidate.endT)}. Muse Spark saw these two frames and nothing else.
          </p>
        </div>
      ) : null}
    </div>
  );
}
