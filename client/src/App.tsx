import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PATHOGEN_IDS, PATHOGENS } from "../../engine/pathogens.ts";
import type { Analysis, PathogenId } from "../../engine/types.ts";
import { api, ApiError, type TracksPayload } from "./api.ts";
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

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekedOnLoad = useRef(false);
  const [clips, setClips] = useState<string[]>([]);
  const [clipId, setClipId] = useState<string | null>(initialClip);
  const [tracks, setTracks] = useState<TracksPayload | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
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
        if (!cancelled) setAnalysis(a);
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

  const rerun = async (override: { pathogen?: PathogenId; sourceEntityId?: string }) => {
    if (!clipId) return;
    setBusy(true);
    setError(null);
    try {
      setAnalysis(await api.analyze(clipId, override));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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

  const sources = (analysis?.entities ?? []).filter((e) => e.class === "object" || e.class === "resident_zone");

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
            <VideoStage videoRef={videoRef} src={api.videoUrl(clipId)} analysis={analysis} index={index} glow={glow} highlight={highlight} onTime={onTime} onDuration={onDuration} />
          ) : (
            <div className="stage placeholder">No clips yet. Upload one through the API or drop a folder under data/clips.</div>
          )}
          {analysis?.momentMisses[0] ? (
            <p className="topfix">
              First missed moment at {analysis.momentMisses[0].t.toFixed(1)} s: Moment {analysis.momentMisses[0].moment}.
              {analysis.momentMisses[0].downstream.length > 0 ? ` Hand hygiene there would have kept ${analysis.momentMisses[0].downstream.length} item${analysis.momentMisses[0].downstream.length === 1 ? "" : "s"} clean.` : ""}
            </p>
          ) : null}
          <Timeline analysis={analysis} duration={duration} currentTime={currentTime} onSeek={seek} onHover={setHighlight} />
          {busy ? <p className="status">Working...</p> : null}
          {error ? <p className="status error">{error}</p> : null}
        </div>
        <Drawer analysis={analysis} open={drawerOpen} onToggle={() => setDrawerOpen((o) => !o)} onSeek={seek} onHover={setHighlight} />
      </main>

      <footer className="badge">{BADGE}</footer>
    </div>
  );
}
