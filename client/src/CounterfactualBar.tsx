import { useEffect, useRef, useState } from "react";
import type { Analysis, Counterfactual, HygieneAgent } from "../../engine/types.ts";
import { api, type ScenarioOverride } from "./api.ts";

interface Props {
  readonly clipId: string;
  readonly analysis: Analysis | null;
  readonly duration: number;
  readonly override: ScenarioOverride;
  readonly onResult: (cf: Counterfactual | null) => void;
}

const DEBOUNCE_MS = 200;

// Deep link: ?cf=<seconds>&agent=alcohol_rub|soap_water opens with the counterfactual active.
const params = new URLSearchParams(window.location.search);
const initialCf = Number(params.get("cf"));
const initialAgent: HygieneAgent = params.get("agent") === "soap_water" ? "soap_water" : "alcohol_rub";
let deepLinkUsed = false;

export function CounterfactualBar({ clipId, analysis, duration, override, onResult }: Props) {
  const [active, setActive] = useState(false);
  const [t, setT] = useState(0);
  const [agent, setAgent] = useState<HygieneAgent>(initialAgent);
  const [result, setResult] = useState<Counterfactual | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  // Reset when the clip or the scenario changes. The deep link applies once, on first load.
  useEffect(() => {
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

  useEffect(() => {
    if (!active || !analysis) return;
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      api
        .counterfactual(clipId, t, agent, override)
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
  }, [active, analysis, clipId, t, agent, override, onResult]);

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
              setActive(e.target.checked);
              if (!e.target.checked) {
                setResult(null);
                setExplanation(null);
                onResult(null);
              }
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
                      .explainCounterfactual(clipId, result.inserted.t, result.inserted.agent, override)
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
