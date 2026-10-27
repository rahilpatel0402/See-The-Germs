import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PATHOGEN_IDS, PATHOGENS } from "../../engine/pathogens.ts";
import type { Analysis, Counterfactual, Narrative, PathogenId } from "../../engine/types.ts";
import { api, ApiError, type ScenarioOverride, type TracksPayload } from "./api.ts";
import { CounterfactualBar } from "./CounterfactualBar.tsx";
import { Drawer } from "./Drawer.tsx";
import { buildOverlayIndex, type OverlayIndex } from "./overlay.ts";
import { Timeline } from "./Timeline.tsx";
import { VideoStage } from "./VideoStage.tsx";

const BADGE = "Staged synthetic footage. Staff training and audit aid. Not surveillance. Not medical advice.";

// Deep link: ?clip=<id>&t=<seconds>&glow=0|1 opens a clip at a moment with the toggle set.
const params = new URLSearchParams(window.location.search);
const initialClip = params.get("clip");
const initialT = Number(params.get("t"));
const initialGlow = params.get("glow") !== "0";

type NarrativeState = "idle" | "loading" | "error" | "ready";

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekedOnLoad = useRef(false);
  const [clips, setClips] = useState<string[]>([]);
  const [clipId, setClipId] = useState<string | null>(initialClip);
  const [tracks, setTracks] = useState<TracksPayload | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [override, setOverride] = useState<ScenarioOverride>({});
  const [counterfactual, setCounterfactual] = useState<Counterfactual | null>(null);
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const [narrativeState, setNarrativeState] = useState<NarrativeState>("idle");
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [glow, setGlow] = useState(initialGlow);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    api
      .clips()
      .then(({ clips }) => {
        setClips(clips);
        setClipId((current) => current ?? clips[0] ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!clipId) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    setTracks(null);
    setAnalysis(null);
    setOverride({});
    setNarrative(null);
    setNarrativeState("idle");
    (async () => {
      try {
        const t = await api.tracks(clipId);
        if (cancelled) return;
        setTracks(t);
        let a: Analysis;
        try {
          a = await api.analysis(clipId);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) a = await api.analyze(clipId);
          else throw e;
        }
        if (cancelled) return;
        setAnalysis(a);
        // A cached narrative for exactly this analysis loads silently; a missing one waits for a
        // click so uploads do not call the model until someone asks.
        try {
          const n = await api.narrative(clipId, { pathogen: a.scenario.pathogen, sourceEntityId: a.scenario.sourceEntityId });
          if (!cancelled) {
            setNarrative(n.narrative);
            setNarrativeState("ready");
          }
        } catch {
          // none cached yet
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clipId]);

  const index: OverlayIndex | null = useMemo(() => (tracks ? buildOverlayIndex(tracks) : null), [tracks]);

  // The scenario the displayed analysis was computed with. Counterfactual and narrative requests
  // always carry it, so they can never disagree with what is on screen, even after a reload.
  const scenario: ScenarioOverride = useMemo(
    () => (analysis ? { pathogen: analysis.scenario.pathogen, sourceEntityId: analysis.scenario.sourceEntityId } : {}),
    [analysis],
  );

  const rerun = async (next: ScenarioOverride) => {
    if (!clipId) return;
    const merged = { ...override, ...next };
    setOverride(merged);
    setBusy(true);
    setError(null);
    setNarrative(null);
    setNarrativeState("idle");
    try {
      setAnalysis(await api.analyze(clipId, merged));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const narrate = () => {
    if (!clipId) return;
    setNarrativeState("loading");
    setNarrativeError(null);
    api
      .narrate(clipId, scenario)
      .then((n) => {
        setNarrative(n.narrative);
        setNarrativeState("ready");
      })
      .catch((e: Error) => {
        setNarrativeError(e.message);
        setNarrativeState("error");
      });
  };

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
  }, []);
  const onTime = useCallback((t: number) => setCurrentTime(t), []);
  const onDuration = useCallback((d: number) => {
    setDuration(d);
    if (!seekedOnLoad.current && Number.isFinite(initialT) && initialT > 0 && videoRef.current) {
      seekedOnLoad.current = true;
      videoRef.current.currentTime = Math.min(initialT, d);
    }
  }, []);
  const onCounterfactual = useCallback((cf: Counterfactual | null) => setCounterfactual(cf), []);

  const sources = (analysis?.entities ?? []).filter((e) => e.class === "object" || e.class === "resident_zone");
  const firstMiss = analysis?.momentMisses[0];

  return (
    <div className="app">
      <header className="topbar">
        <h1>See the Germs</h1>
        <div className="controls">
          <label>
            Clip{" "}
            <select value={clipId ?? ""} onChange={(e) => setClipId(e.target.value)} disabled={busy}>
              {clips.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pathogen{" "}
            <select value={analysis?.scenario.pathogen ?? "mrsa"} onChange={(e) => void rerun({ pathogen: e.target.value as PathogenId })} disabled={!analysis || busy}>
              {PATHOGEN_IDS.map((id) => (
                <option key={id} value={id}>
                  {PATHOGENS[id].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source{" "}
            <select value={analysis?.scenario.sourceEntityId ?? ""} onChange={(e) => void rerun({ sourceEntityId: e.target.value })} disabled={!analysis || busy}>
              {sources.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={`germs-toggle${glow ? " on" : ""}`} onClick={() => setGlow((g) => !g)} aria-pressed={glow}>
            See the Germs
          </button>
        </div>
      </header>

      <main className={`main${drawerOpen ? " with-drawer" : ""}`}>
        <div className="stage-column">
          {clipId ? (
            <VideoStage
              videoRef={videoRef}
              src={api.videoUrl(clipId)}
              analysis={analysis}
              propagation={counterfactual?.propagation ?? null}
              index={index}
              glow={glow}
              highlight={highlight}
              onTime={onTime}
              onDuration={onDuration}
            />
          ) : (
            <div className="stage placeholder">No clips yet. Upload one through the API or drop a folder under data/clips.</div>
          )}
          {counterfactual ? (
            <p className="topfix cf-banner">Showing the clip as if hands had been cleaned at {counterfactual.inserted.t.toFixed(1)} s.</p>
          ) : narrative ? (
            <p className="topfix">{narrative.top_fix}</p>
          ) : firstMiss ? (
            <p className="topfix">
              First missed moment at {firstMiss.t.toFixed(1)} s: Moment {firstMiss.moment}.
              {firstMiss.downstream.length > 0 ? ` Hand hygiene there would have kept ${firstMiss.downstream.length} item${firstMiss.downstream.length === 1 ? "" : "s"} clean.` : ""}
            </p>
          ) : null}
          <Timeline analysis={analysis} duration={duration} currentTime={currentTime} onSeek={seek} onHover={setHighlight} />
          {clipId ? <CounterfactualBar clipId={clipId} analysis={analysis} duration={duration} override={scenario} onResult={onCounterfactual} /> : null}
          {busy ? <p className="status">Working...</p> : null}
          {error ? <p className="status error">{error}</p> : null}
        </div>
        <Drawer
          analysis={analysis}
          narrative={narrative}
          narrativeState={narrativeState}
          narrativeError={narrativeError}
          onNarrate={narrate}
          open={drawerOpen}
          onToggle={() => setDrawerOpen((o) => !o)}
          onSeek={seek}
          onHover={setHighlight}
        />
      </main>

      <footer className="badge">{BADGE}</footer>
    </div>
  );
}
