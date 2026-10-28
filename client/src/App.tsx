import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PATHOGEN_IDS, PATHOGENS } from "../../engine/pathogens.ts";
import type { Analysis, Counterfactual, MaskBounds, Narrative, PathogenId } from "../../engine/types.ts";
import { MarkObject } from "./MarkObject.tsx";
import { Session } from "./Session.tsx";
import { api, ApiError, type ScenarioOverride, type TracksPayload } from "./api.ts";
import { CounterfactualBar } from "./CounterfactualBar.tsx";
import { Drawer } from "./Drawer.tsx";
import { buildOverlayIndex, type OverlayIndex, type OverlayMode } from "./overlay.ts";
import { Timeline } from "./Timeline.tsx";
import { Upload } from "./Upload.tsx";
import { VideoStage } from "./VideoStage.tsx";

const BADGE = "Staged synthetic footage. Staff training and audit aid. Not surveillance. Not medical advice.";

// Deep link: ?clip=<id>&t=<seconds>&glow=0|1 opens a clip at a moment with the toggle set.
const params = new URLSearchParams(window.location.search);
const initialClip = params.get("clip");
const initialT = Number(params.get("t"));
const initialMode: OverlayMode = params.get("mode") === "heat" ? "heat" : params.get("glow") === "0" ? "off" : "glow";

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
  const [mode, setMode] = useState<OverlayMode>(initialMode);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ open: boolean; resume: string | null }>({ open: params.get("upload") === "1", resume: null });
  const [sessionOpen, setSessionOpen] = useState(params.get("session") === "1");
  // Bumped to reload the current clip after its setup completes, since the id itself may not change.
  const [reload, setReload] = useState(0);
  const [demoClips, setDemoClips] = useState<string[]>([]);
  const [marking, setMarking] = useState(false);
  const [pendingBox, setPendingBox] = useState<{ box: MaskBounds; frameIndex: number } | null>(null);

  const refreshClips = useCallback(
    () =>
      api
        .clips()
        .then(({ clips, demo }) => {
          setClips(clips);
          setDemoClips(demo);
          setClipId((current) => current ?? clips[0] ?? null);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void refreshClips();
  }, [refreshClips]);

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
          if (e instanceof ApiError && e.status === 404) {
            try {
              a = await api.analyze(clipId);
            } catch (inner) {
              // Not segmented yet: a clip whose setup was interrupted. Resume it in the upload panel.
              if (inner instanceof ApiError && inner.status === 409) {
                if (!cancelled) setUpload({ open: true, resume: clipId });
                return;
              }
              throw inner;
            }
          } else throw e;
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
  }, [clipId, reload]);

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

  // Arrow keys step one frame, space toggles play, when the focus is not in a form control.
  useEffect(() => {
    const fps = tracks?.fps ?? 10;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        v.pause();
        const step = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1);
        v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + step / fps));
      } else if (e.key === " ") {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tracks]);

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
          <button type="button" onClick={() => setUpload({ open: true, resume: null })}>
            Upload your own
          </button>
          <button type="button" onClick={() => setSessionOpen((o) => !o)} aria-pressed={sessionOpen} title="Compliance across several clips, and before and after">
            Session report
          </button>
          {clipId && !demoClips.includes(clipId) && tracks ? (
            <button
              type="button"
              className={marking ? "on" : ""}
              onClick={() => {
                setPendingBox(null);
                setMarking((m) => !m);
              }}
              aria-pressed={marking}
              title="Draw a box around an object SAM missed; it is tracked through the clip"
            >
              {marking ? "Cancel marking" : "Mark an object"}
            </button>
          ) : null}
          <div className="mode-switch" role="group" aria-label="overlay mode">
            <button type="button" className={mode === "off" ? "on" : ""} onClick={() => setMode("off")} aria-pressed={mode === "off"}>
              Off
            </button>
            <button type="button" className={`germs-toggle${mode === "glow" ? " on" : ""}`} onClick={() => setMode("glow")} aria-pressed={mode === "glow"}>
              See the Germs
            </button>
            <button type="button" className={mode === "heat" ? "on heat" : ""} onClick={() => setMode("heat")} aria-pressed={mode === "heat"} title="How long each surface has been contaminated so far">
              Heat
            </button>
          </div>
        </div>
      </header>

      {sessionOpen ? (
        <Session
          clips={clips}
          onClose={() => setSessionOpen(false)}
          onOpenClip={(id) => {
            setSessionOpen(false);
            setClipId(id);
          }}
        />
      ) : null}

      {upload.open ? (
        <Upload
          resumeClipId={upload.resume}
          onClose={() => setUpload({ open: false, resume: null })}
          onDone={(id) => {
            setUpload({ open: false, resume: null });
            void refreshClips().then(() => {
              setClipId(id);
              setReload((n) => n + 1);
            });
          }}
        />
      ) : null}

      <main className={`main${drawerOpen ? " with-drawer" : ""}`}>
        <div className="stage-column">
          {clipId ? (
            <VideoStage
              videoRef={videoRef}
              src={api.videoUrl(clipId)}
              analysis={analysis}
              propagation={counterfactual?.propagation ?? null}
              index={index}
              mode={mode}
              highlight={highlight}
              marking={marking && !pendingBox}
              onBox={(box, frameIndex) => setPendingBox({ box, frameIndex })}
              onTime={onTime}
              onDuration={onDuration}
            />
          ) : (
            <div className="stage placeholder">No clips yet. Upload one through the API or drop a folder under data/clips.</div>
          )}
          {clipId && pendingBox && tracks ? (
            <MarkObject
              clipId={clipId}
              box={pendingBox.box}
              frameIndex={pendingBox.frameIndex}
              fps={tracks.fps}
              onCancel={() => setPendingBox(null)}
              onDone={() => {
                setPendingBox(null);
                setMarking(false);
                setReload((n) => n + 1);
              }}
            />
          ) : null}
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
          <Timeline clipId={clipId} analysis={analysis} duration={duration} currentTime={currentTime} onSeek={seek} onHover={setHighlight} />
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
