import { useEffect, useRef, useState } from "react";

interface Props {
  readonly maxSeconds: number;
  readonly onFile: (file: File) => void;
  readonly onCancel: () => void;
}

const MIME_PREFERENCE = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

// Records a clip in the browser with the device camera and hands it to the upload flow. The
// server resamples whatever container the browser produces.
export function Record({ maxSeconds, onFile, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [state, setState] = useState<"starting" | "ready" | "recording" | "review" | "error">("starting");
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Record again" to reopen the camera without leaving the panel.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("starting");
    setError(null);
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setState("ready");
      } catch (e) {
        setError((e as Error).message);
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [attempt]);

  // Stop a second before the server's cap so the file never lands just over it.
  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    const limit = Math.max(5, maxSeconds - 1);
    const timer = window.setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setSeconds(s);
      if (s >= limit) stop();
    }, 200);
    return () => window.clearInterval(timer);
  }, [state, maxSeconds]);

  const start = () => {
    const stream = streamRef.current;
    if (!stream) return;
    const mimeType = MIME_PREFERENCE.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || "video/webm";
      const out = new Blob(chunksRef.current, { type });
      setBlob(out);
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.src = URL.createObjectURL(out);
        videoRef.current.controls = true;
        videoRef.current.muted = true;
      }
      setState("review");
    };
    recorderRef.current = recorder;
    recorder.start(250);
    setSeconds(0);
    setState("recording");
  };

  const stop = () => {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  };

  // Drop the reviewed take, put the element back on the live stream, and open the camera again.
  const again = () => {
    const v = videoRef.current;
    if (v) {
      if (v.src) URL.revokeObjectURL(v.src);
      v.removeAttribute("src");
      v.controls = false;
      v.load();
    }
    setBlob(null);
    setSeconds(0);
    chunksRef.current = [];
    setAttempt((n) => n + 1);
  };

  const use = () => {
    if (!blob) return;
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    onFile(new File([blob], `recorded.${ext}`, { type: blob.type }));
  };

  return (
    <div className="record-panel">
      <video ref={videoRef} playsInline muted autoPlay />
      <div className="record-row">
        {state === "starting" ? <span className="muted">Starting the camera...</span> : null}
        {state === "ready" ? (
          <button type="button" onClick={start}>
            Start recording (up to {maxSeconds - 1} s)
          </button>
        ) : null}
        {state === "recording" ? (
          <>
            <span className="rec-dot" /> <span>{seconds.toFixed(0)} s</span>
            <button type="button" onClick={stop}>
              Stop
            </button>
          </>
        ) : null}
        {state === "review" ? (
          <>
            <button type="button" onClick={use}>
              Use this clip
            </button>
            <button type="button" className="link" onClick={again}>
              Record again
            </button>
          </>
        ) : null}
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error ? <p className="status error">Camera unavailable: {error}. Upload a file instead.</p> : null}
      <p className="muted">Landscape, camera at an angle, bright light, staged props only. No real patients, no real facilities.</p>
    </div>
  );
}
