import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis, Counterfactual, HygieneAgent } from "../../engine/types.ts";
import { api, type ScenarioOverride } from "./api.ts";

interface Props {
  readonly clipId: string;
  readonly analysis: Analysis | null;
  readonly duration: number;
  readonly override: ScenarioOverride;
  readonly onResult: (cf: Counterfactual | null) => void;
  // "Show me": the parent asks for the counterfactual at a time; a new object activates it.
  readonly request: { t: number; agent?: HygieneAgent } | null;
}

const DEBOUNCE_MS = 200;

// Deep link: ?cf=<seconds>&agent=alcohol_rub|soap_water opens with the counterfactual active.
const params = new URLSearchParams(window.location.search);
const initialCf = Number(params.get("cf"));
const initialAgent: HygieneAgent = params.get("agent") === "soap_water" ? "soap_water" : "alcohol_rub";
let deepLinkUsed = false;

export function CounterfactualBar({ clipId, analysis, duration, override, onResult, request }: Props) {
  useEffect(() => {
    if (!request) return;
    setT(Number(request.t.toFixed(1)));
    if (request.agent) setAgent(request.agent);
    setActive(true);
  }, [request]);
  const [active, setActive] = useState(false);
  const [t, setT] = useState(0);
  const [agent, setAgent] = useState<HygieneAgent>(initialAgent);
  // One hand entity per person; the slider cleans that person's hands.
  const persons = useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const e of analysis?.entities ?? []) {
      if (e.class !== "bare_hand" && e.class !== "gloved_hand") continue;
      const p = e.person ?? "P1";
      if (!seen.has(p) || e.class === "bare_hand") seen.set(p, { id: e.id, label: p });
    }
    return [...seen.values()];
  }, [analysis]);
  const [handId, setHandId] = useState<string | undefined>(undefined);
  const effectiveHand = handId ?? persons[0]?.id;
  const [result, setResult] = useState<Counterfactual | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  // Reset when the clip or the scenario changes. The deep link applies once, on first load.
  // Bumping requestId drops any response still in flight.
  useEffect(() => {
    requestId.current++;
    if (!deepLinkUsed && analysis && Number.isFinite(initialCf) && initialCf > 0) {
      deepLinkUsed = true;
      setT(initialCf);
      setActive(true);
      return;
    }
    setActive(false);
    setResult(null);
    setExplanation(null);
    onResult(null);
  }, [clipId, analysis, onResult]);

  const deactivate = () => {
    requestId.current++;
    setActive(false);
    setResult(null);
    setExplanation(null);
    onResult(null);
  };

  useEffect(() => {
    if (!active || !analysis) return;
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      api
        .counterfactual(clipId, t, agent, effectiveHand, override)
        .then((cf) => {
          if (id !== requestId.current) return;
          setResult(cf);
          setExplanation(null);
          setError(null);
          onResult(cf);
        })
        .catch((e: Error) => {
          if (id === requestId.current) setError(e.message);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, analysis, clipId, t, agent, effectiveHand, override, onResult]);

  if (!analysis) return null;
  const labels = new Map(analysis.entities.map((e) => [e.id, e.label]));
  const name = (id: string): string => labels.get(id) ?? id;

  return (
    <div className={`counterfactual${active ? " active" : ""}`}>
      <div className="cf-row">
        <label className="cf-toggle">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => {
              if (e.target.checked) setActive(true);
              else deactivate();
            }}
          />{" "}
          What if hands had been cleaned at
        </label>
        <input type="range" min={0} max={Math.max(0.1, duration)} step={0.1} value={t} disabled={!active} onChange={(e) => setT(Number(e.target.value))} aria-label="insert hand hygiene at time" />
        <span className="cf-time">{t.toFixed(1)} s</span>
        <select value={agent} disabled={!active} onChange={(e) => setAgent(e.target.value as HygieneAgent)} aria-label="hygiene agent">
          <option value="alcohol_rub">alcohol rub</option>
          <option value="soap_water">soap and water</option>
        </select>
        {persons.length > 1 ? (
          <select value={effectiveHand ?? ""} disabled={!active} onChange={(e) => setHandId(e.target.value)} aria-label="whose hands">
            {persons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {active && result ? (
        <div className="cf-cards">
          <div className="cf-card">
            <span className="cf-label">Before</span>
            <span className="cf-score">{result.before.score}</span>
            <span className="cf-detail">
              {result.before.contaminatedSurfaces} surfaces, {sum(result.before.residentExposures)} resident exposures, {sum(result.before.momentsMissed)} moments missed
            </span>
          </div>
          <div className="cf-card after">
            <span className="cf-label">After</span>
            <span className="cf-score">{result.after.score}</span>
            <span className="cf-detail">
              {result.after.contaminatedSurfaces} surfaces, {sum(result.after.residentExposures)} resident exposures, {sum(result.after.momentsMissed)} moments missed
            </span>
          </div>
          <div className="cf-card wide">
            {!result.inserted.effective ? (
              <span className="warn">
                {result.inserted.agent === "alcohol_rub" ? "Alcohol rub" : "Soap and water"} does not clear {analysis.pathogen.label} from hands, so nothing changes.
              </span>
            ) : result.keptClean.length > 0 ? (
              <span>Kept clean: {result.keptClean.map(name).join(", ")}.</span>
            ) : (
              <span className="muted">Nothing changes at this point in the clip.</span>
            )}
            <div>
              {explanation ? (
                <span className="muted">{explanation}</span>
              ) : (
                <button
                  type="button"
                  className="link"
                  disabled={explaining}
                  onClick={() => {
                    setExplaining(true);
                    api
                      .explainCounterfactual(clipId, result.inserted.t, result.inserted.agent, result.inserted.handId, override)
                      .then((r) => setExplanation(r.explanation))
                      .catch((e: Error) => setError(e.message))
                      .finally(() => setExplaining(false));
                  }}
                >
                  {explaining ? "Explaining..." : "Explain in words"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {error ? <p className="status error">{error}</p> : null}
    </div>
  );
}

function sum(record: Readonly<Record<string, number>>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}
