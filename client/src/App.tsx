import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PATHOGEN_IDS, PATHOGENS } from "../../engine/pathogens.ts";
import type { Analysis, Counterfactual, HygieneAgent, MaskBounds, Narrative, PathogenId } from "../../engine/types.ts";
import { api, ApiError, type ClipDetail, type NarrativeLanguage, type ScenarioOverride, type TracksPayload } from "./api.ts";
import { ClipCards } from "./ClipCards.tsx";
import { CounterfactualBar } from "./CounterfactualBar.tsx";
import { Drawer, type View } from "./Drawer.tsx";
import { Legend } from "./Legend.tsx";
import { MarkObject } from "./MarkObject.tsx";
import { buildOverlayIndex, type OverlayIndex, type OverlayMode } from "./overlay.ts";
import { Session } from "./Session.tsx";
import { Timeline } from "./Timeline.tsx";
import { Upload } from "./Upload.tsx";
import { VideoStage } from "./VideoStage.tsx";

const BADGE = "Staged synthetic footage. Staff training and audit aid. Not surveillance. Not medical advice.";

// Deep link: ?clip=<id>&t=<seconds>&glow=0|1&mode=heat&view=coach|audit&lang=es opens a clip at
// a moment with the overlay, the view, and the note language set.
const params = new URLSearchParams(window.location.search);
const initialClip = params.get("clip");
const initialT = Number(params.get("t"));
const initialMode: OverlayMode = params.get("mode") === "heat" ? "heat" : params.get("glow") === "0" ? "off" : "glow";
const initialView: View = params.get("view") === "audit" ? "audit" : "coach";
const initialLanguage: NarrativeLanguage = params.get("lang") === "es" ? "es" : "en";

type NarrativeState = "idle" | "loading" | "error" | "ready";

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekedOnLoad = useRef(false);
  const [clips, setClips] = useState<string[]>([]);
  const [details, setDetails] = useState<ClipDetail[]>([]);
  const [demoClips, setDemoClips] = useState<string[]>([]);
  const [clipId, setClipId] = useState<string | null>(initialClip);
  const [tracks, setTracks] = useState<TracksPayload | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [override, setOverride] = useState<ScenarioOverride>({});
  const [counterfactual, setCounterfactual] = useState<Counterfactual | null>(null);
  const [cfRequest, setCfRequest] = useState<{ t: number; agent?: HygieneAgent } | null>(null);
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const [narrativeState, setNarrativeState] = useState<NarrativeState>("idle");
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  const [language, setLanguage] = useState<NarrativeLanguage>(initialLanguage);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<OverlayMode>(initialMode);
  const [view, setView] = useState<View>(initialView);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ open: boolean; resume: string | null }>({ open: params.get("upload") === "1", resume: null });
  const [sessionOpen, setSessionOpen] = useState(params.get("session") === "1");
  const [cardsOpen, setCardsOpen] = useState(params.get("clips") === "1");
  const [reload, setReload] = useState(0);
  const [marking, setMarking] = useState(false);
  const [pendingBox, setPendingBox] = useState<{ box: MaskBounds; frameIndex: number } | null>(null);

  const refreshClips = useCallback(
    () =>
      api
        .clips()
        .then(({ clips, demo, details }) => {
          setClips(clips);
          setDemoClips(demo);
          setDetails(details);
          setClipId((current) => (current && clips.includes(current) ? current : clips[0] ?? null));
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void refreshClips();
  }, [refreshClips]);

  // Load the clip: tracks, analysis (or run it), and a cached narrative for the shown scenario.
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
    setCfRequest(null);
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
        try {
          const n = await api.narrative(clipId, { pathogen: a.scenario.pathogen, sourceEntityId: a.scenario.sourceEntityId }, language);
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
    // language changes are handled below without reloading the clip
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, reload]);

  const index: OverlayIndex | null = useMemo(() => (tracks ? buildOverlayIndex(tracks) : null), [tracks]);

  const scenario: ScenarioOverride = useMemo(
    () => (analysis ? { pathogen: analysis.scenario.pathogen, sourceEntityId: analysis.scenario.sourceEntityId } : {}),
    [analysis],
  );

  // Language switch: use the cached narrative in that language if it exists, else wait for a click.
  useEffect(() => {
    if (!clipId || !analysis) return;
    let cancelled = false;
    setNarrative(null);
    setNarrativeState("idle");
    api
      .narrative(clipId, scenario, language)
      .then((n) => {
        if (!cancelled) {
          setNarrative(n.narrative);
          setNarrativeState("ready");
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [language, clipId, analysis, scenario]);

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
      .narrate(clipId, scenario, language)
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

  // "Show me": seek to the moment and open the counterfactual there, so the proof is one click away.
  const showMe = useCallback(
    (t: number) => {
      seek(Math.max(0, t));
      setCfRequest({ t: Math.max(0, t) });
    },
    [seek],
  );

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
  const current = details.find((d) => d.id === clipId);
  const topFixText = narrative?.top_fix ?? (firstMiss ? `The highest-impact change in this clip was hand hygiene at ${firstMiss.t.toFixed(1)} seconds (Moment ${firstMiss.moment}).` : analysis ? "No missed hand hygiene moments in this clip." : null);

  return (
    <div className={`app view-${view}`}>
      <header className="topbar">
        <h1>See the Germs</h1>
        <div className="controls">
          <button type="button" onClick={() => setCardsOpen((o) => !o)} aria-pressed={cardsOpen} title="Pick a clip">
            {current ? current.title : "Clips"}
          </button>
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
          {view === "audit" ? (
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
          ) : null}
          <button type="button" onClick={() => setUpload({ open: true, resume: null })}>
            Upload your own
          </button>
          {view === "audit" ? (
            <button type="button" onClick={() => setSessionOpen((o) => !o)} aria-pressed={sessionOpen} title="Compliance across several clips, and before and after">
              Session report
            </button>
          ) : null}
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

      {cardsOpen ? (
        <ClipCards
          details={details}
          current={clipId}
          onOpen={(id) => {
            setCardsOpen(false);
            setClipId(id);
            setReload((n) => n + 1);
          }}
          onChanged={() => void refreshClips()}
          onClose={() => setCardsOpen(false)}
        />
      ) : null}

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
            <div className="stage-wrap">
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
              <Legend mode={mode} />
            </div>
          ) : (
            <div className="stage placeholder">No clips yet. Upload one, or record one with the camera.</div>
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
          ) : topFixText ? (
            <div className="topfix hero">
              <span>{topFixText}</span>
              {firstMiss ? (
                <button type="button" className="show-me" onClick={() => showMe(firstMiss.t)}>
                  Show me
                </button>
              ) : null}
            </div>
          ) : null}
          <Timeline clipId={clipId} analysis={analysis} duration={duration} currentTime={currentTime} onSeek={seek} onHover={setHighlight} />
          {clipId ? <CounterfactualBar clipId={clipId} analysis={analysis} duration={duration} override={scenario} onResult={onCounterfactual} request={cfRequest} /> : null}
          {busy ? <p className="status">Working...</p> : null}
          {error ? <p className="status error">{error}</p> : null}
        </div>
        <Drawer
          analysis={analysis}
          narrative={narrative}
          narrativeState={narrativeState}
          narrativeError={narrativeError}
          language={language}
          onLanguage={setLanguage}
          onNarrate={narrate}
          view={view}
          onView={setView}
          open={drawerOpen}
          onToggle={() => setDrawerOpen((o) => !o)}
          onSeek={seek}
          onHover={setHighlight}
          onShowMe={showMe}
        />
      </main>

      <footer className="badge">{BADGE}</footer>
    </div>
  );
}
