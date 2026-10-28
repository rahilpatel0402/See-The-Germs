import { useState } from "react";
import type { DispenserAgent, EntityClass, MaskBounds, ZoneTag } from "../../engine/types.ts";
import { api } from "./api.ts";

interface Props {
  readonly clipId: string;
  readonly box: MaskBounds;
  readonly frameIndex: number;
  readonly fps: number;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

const ZONES: ZoneTag[] = ["patient_zone_A", "patient_zone_B", "healthcare_area", "hygiene_station"];
const KINDS: EntityClass[] = ["object", "resident_zone", "dispenser"];

// Names a drawn box and sends it to SAM as a box prompt tracked through the whole clip.
export function MarkObject({ clipId, box, frameIndex, fps, onDone, onCancel }: Props) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<EntityClass>("object");
  const [zone, setZone] = useState<ZoneTag>("healthcare_area");
  const [agent, setAgent] = useState<DispenserAgent>("alcohol_rub");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ frames: number; objects: number } | null>(null);

  const submit = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.trackBox(clipId, {
        frameIndex,
        box,
        label: label.trim(),
        kind: kind as "object" | "resident_zone" | "dispenser",
        zone,
        ...(kind === "dispenser" ? { agent } : {}),
      });
      setResult({ frames: r.frames, objects: r.objects });
      window.setTimeout(onDone, 900);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mark-form" role="dialog" aria-label="name the marked object">
      <p>
        Box {box.right - box.left} by {box.bottom - box.top} px on frame {frameIndex} ({(frameIndex / fps).toFixed(1)} s). SAM will track it through the whole clip from this one box.
      </p>
      <div className="mark-row">
        <input placeholder="label, e.g. call button" value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} autoFocus />
        <select value={kind} onChange={(e) => setKind(e.target.value as EntityClass)} disabled={busy}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k.replace("_", " ")}
            </option>
          ))}
        </select>
        <select value={zone} onChange={(e) => setZone(e.target.value as ZoneTag)} disabled={busy}>
          {ZONES.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {kind === "dispenser" ? (
          <select value={agent} onChange={(e) => setAgent(e.target.value as DispenserAgent)} disabled={busy}>
            <option value="alcohol_rub">alcohol rub</option>
            <option value="soap_water">soap and water</option>
            <option value="gloves">gloves</option>
          </select>
        ) : null}
        <button type="button" onClick={() => void submit()} disabled={busy || !label.trim()}>
          {busy ? "SAM is tracking..." : "Track it"}
        </button>
        <button type="button" className="link" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {result ? (
        <p className="ok">
          Tracked in {result.frames} frames ({result.objects} object{result.objects === 1 ? "" : "s"}). Reanalyzing.
        </p>
      ) : null}
      {error ? <p className="status error">{error}</p> : null}
    </div>
  );
}
