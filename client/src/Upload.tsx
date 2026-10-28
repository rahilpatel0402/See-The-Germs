import { useEffect, useState } from "react";
import type { DispenserAgent, EntityClass, ZoneTag } from "../../engine/types.ts";
import { api, ApiError, segmentStream, uploadClip, type EntityConfig, type SceneResult, type SegmentLine } from "./api.ts";
import { TASK_PRESETS } from "./presets.ts";
import { Record } from "./Record.tsx";

type Step = "pick" | "uploading" | "entities" | "segmenting" | "adjudicating" | "analyzing" | "done";

interface Props {
  // When set, the panel opens at the prop-naming step for a clip that already exists.
  readonly resumeClipId: string | null;
  readonly onDone: (clipId: string) => void;
  readonly onClose: () => void;
}

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "uploading", label: "Upload the clip" },
  { id: "entities", label: "Name the props" },
  { id: "segmenting", label: "Track hands and surfaces with SAM 3.1" },
  { id: "adjudicating", label: "Review ambiguous moments with Muse Spark" },
  { id: "analyzing", label: "Run the engine" },
];

const ZONES: ZoneTag[] = ["patient_zone_A", "patient_zone_B", "healthcare_area", "hygiene_station"];
const CLASSES: EntityClass[] = ["object", "resident_zone", "dispenser"];
const AGENTS: DispenserAgent[] = ["alcohol_rub", "soap_water", "gloves"];

export function Upload({ resumeClipId, onDone, onClose }: Props) {
  const [step, setStep] = useState<Step>(resumeClipId ? "entities" : "pick");
  const [clipId, setClipId] = useState<string | null>(resumeClipId);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [entities, setEntities] = useState<EntityConfig[]>([]);
  const [lines, setLines] = useState<SegmentLine[]>([]);
  const [adjudicated, setAdjudicated] = useState<{ added: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [proposing, setProposing] = useState(false);
  const [scene, setScene] = useState<SceneResult | null>(null);

  const propose = async () => {
    if (!clipId) return;
    setProposing(true);
    setError(null);
    try {
      const result = await api.scene(clipId);
      setScene(result);
      setEntities(result.entities);
    } catch (e) {
      fail(e);
    } finally {
      setProposing(false);
    }
  };
  const verification = (id: string): string | null => {
    const r = scene?.report.find((x) => x.id === id);
    if (!r) return null;
    const best = r.tried.find((t) => t.phrase === r.chosen) ?? r.tried.at(-1);
    return r.verified ? `SAM found it: ${best?.objects} object${best?.objects === 1 ? "" : "s"}, confidence ${best?.meanConfidence?.toFixed(2) ?? "?"}` : `SAM did not find it with ${r.tried.length} phrase${r.tried.length === 1 ? "" : "s"}; edit the phrase`;
  };

  useEffect(() => {
    if (!resumeClipId) return;
    api
      .clip(resumeClipId)
      .then((info) => {
        setEntities(info.entities);
        setDuration(info.clip.source.durationS);
      })
      .catch((e: Error) => setError(e.message));
  }, [resumeClipId]);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const [recording, setRecording] = useState(false);

  const startUpload = async (chosen?: File) => {
    const f = chosen ?? file;
    if (!f) return;
    setError(null);
    setStep("uploading");
    setProgress(0);
    try {
      const info = await uploadClip(f, setProgress);
      setClipId(info.clip.id);
      setEntities(info.entities);
      setDuration(info.clip.source.durationS);
      setStep("entities");
    } catch (e) {
      setStep("pick");
      fail(e);
    }
  };

  const runPipeline = async () => {
    if (!clipId) return;
    setError(null);
    try {
      await api.saveEntities(clipId, entities);
    } catch (e) {
      fail(e);
      return;
    }
    setStep("segmenting");
    setLines([]);
    try {
      await segmentStream(clipId, (line) => {
        if (line.phrase) setLines((prev) => [...prev, line]);
      });
    } catch (e) {
      fail(e);
      return;
    }
    setStep("adjudicating");
    try {
      const result = await api.adjudicate(clipId);
      setAdjudicated({ added: result.added.length, failed: result.failed.length });
    } catch (e) {
      // Adjudication failing (for example, the model is briefly unavailable) is not fatal: ambiguous
      // candidates stay unreviewed and are not counted. Say so and continue.
      setAdjudicated({ added: 0, failed: -1 });
      if (!(e instanceof ApiError)) fail(e);
    }
    setStep("analyzing");
    try {
      await api.analyze(clipId);
    } catch (e) {
      fail(e);
      return;
    }
    setStep("done");
    onDone(clipId);
  };

  const update = (i: number, patch: Partial<EntityConfig>) =>
    setEntities((prev) =>
      prev.map((e, j) => {
        if (j !== i) return e;
        const next = { ...e, ...patch } as EntityConfig;
        // A dispenser needs an agent; a non-dispenser must not carry one.
        if (next.class === "dispenser" && next.agent === undefined) return { ...next, agent: "alcohol_rub" };
        if (next.class !== "dispenser" && next.agent !== undefined) {
          const { agent: _dropped, ...rest } = next;
          return rest as EntityConfig;
        }
        return next;
      }),
    );
  const remove = (i: number) => setEntities((prev) => prev.filter((_, j) => j !== i));
  const add = () =>
    setEntities((prev) => {
      const used = new Set(prev.map((e) => e.id));
      let n = prev.length + 1;
      while (used.has(`prop_${n}`)) n++;
      return [...prev, { id: `prop_${n}`, label: "new prop", class: "object", zone: "healthcare_area", samPhrase: "" }];
    });

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="upload-panel" role="dialog" aria-label="Upload your own clip">
      <div className="upload-head">
        <h2>Upload your own</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">
        Staged footage only, up to 45 seconds, landscape, camera at an angle. No real patients, no real facilities. Processing takes about a minute and costs
        a few cents of the hackathon credit.
      </p>

      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < stepIndex || step === "done" ? "done" : i === stepIndex ? "current" : ""}>
            {s.label}
            {s.id === "uploading" && step === "uploading" ? <span className="muted"> {Math.round(progress * 100)}%</span> : null}
            {s.id === "segmenting" && lines.length > 0 ? (
              <ul className="plain muted small">
                {lines.map((l) => (
                  <li key={l.phrase}>
                    {l.phrase}: {l.objects} object{l.objects === 1 ? "" : "s"} in {l.frames} frames
                  </li>
                ))}
              </ul>
            ) : null}
            {s.id === "adjudicating" && adjudicated ? (
              <span className="muted">
                {" "}
                {adjudicated.failed === -1 ? "skipped, the model was unavailable" : `${adjudicated.added} reviewed${adjudicated.failed > 0 ? `, ${adjudicated.failed} failed` : ""}`}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {step === "pick" && !recording ? (
        <div className="upload-pick">
          <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" disabled={!file} onClick={() => void startUpload()}>
            Upload
          </button>
          <span className="muted">or</span>
          <button type="button" onClick={() => setRecording(true)}>
            Record with the camera
          </button>
        </div>
      ) : null}
      {step === "pick" && recording ? (
        <Record
          maxSeconds={45}
          onCancel={() => setRecording(false)}
          onFile={(f) => {
            setRecording(false);
            setFile(f);
            void startUpload(f);
          }}
        />
      ) : null}

      {step === "entities" ? (
        <div className="entities-editor">
          <p className="muted">
            {duration !== null ? `${duration.toFixed(1)} s clip. ` : ""}
            Name what is in the scene. The phrase is what SAM looks for: describe how the prop looks, not what it is for ("white rod" works, "bed rail" may not).
            Keep the two hands. Remove props that are not in the clip.
          </p>
          <p className="mark-row">
            <label>
              Which task is this?{" "}
              <select
                defaultValue=""
                onChange={(e) => {
                  const preset = TASK_PRESETS.find((p) => p.id === e.target.value);
                  if (preset) setEntities(preset.entities.map((x) => ({ ...x })));
                }}
              >
                <option value="">choose a preset...</option>
                {TASK_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">Loads the usual props and zones for that task; edit or let Spark refine them.</span>
          </p>
          <p>
            <button type="button" disabled={proposing} onClick={() => void propose()}>
              {proposing ? "Muse Spark is looking at three frames and SAM is checking each phrase..." : "Let Muse Spark propose the props"}
            </button>{" "}
            {scene ? (
              <span className="muted">
                {scene.report.length} props proposed, {scene.report.filter((r) => r.verified).length} verified by SAM, about ${scene.cost.toFixed(2)}.
              </span>
            ) : (
              <span className="muted">Spark proposes, SAM verifies each phrase on a frame, anything unfound goes back to Spark once. A few cents.</span>
            )}
          </p>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>SAM phrase</th>
                <th>Kind</th>
                <th>Zone</th>
                <th>Agent</th>
                <th>SAM check</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entities.map((e, i) => {
                const hand = e.class === "bare_hand" || e.class === "gloved_hand";
                return (
                  <tr key={e.id}>
                    <td>
                      <input value={e.label} onChange={(ev) => update(i, { label: ev.target.value })} />
                    </td>
                    <td>
                      <input value={e.samPhrase} onChange={(ev) => update(i, { samPhrase: ev.target.value })} />
                    </td>
                    <td>
                      {hand ? (
                        <span className="muted">{e.class.replace("_", " ")}</span>
                      ) : (
                        <select value={e.class} onChange={(ev) => update(i, { class: ev.target.value as EntityClass })}>
                          {CLASSES.map((c) => (
                            <option key={c} value={c}>
                              {c.replace("_", " ")}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      <select value={e.zone} onChange={(ev) => update(i, { zone: ev.target.value as ZoneTag })}>
                        {ZONES.map((z) => (
                          <option key={z} value={z}>
                            {z.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {e.class === "dispenser" ? (
                        <select value={e.agent} onChange={(ev) => update(i, { agent: ev.target.value as DispenserAgent })}>
                          {AGENTS.map((a) => (
                            <option key={a} value={a}>
                              {a.replace("_", " ")}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </td>
                    <td className="muted small">{hand ? "" : (verification(e.id) ?? "")}</td>
                    <td>{hand ? null : <button type="button" className="link" onClick={() => remove(i)}>remove</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="upload-actions">
            <button type="button" className="link" onClick={add}>
              Add a prop
            </button>
            <button type="button" onClick={() => void runPipeline()}>
              Save and process
            </button>
          </div>
        </div>
      ) : null}

      {step === "segmenting" || step === "adjudicating" || step === "analyzing" ? <p className="status">Working...</p> : null}
      {error ? (
        <p className="status error">
          {error}{" "}
          {step === "pick" || step === "entities" ? null : (
            <button type="button" className="link" onClick={() => setStep("entities")}>
              Back to the props
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}
