import { useState } from "react";
import { api, type ClipDetail } from "./api.ts";

interface Props {
  readonly details: readonly ClipDetail[];
  readonly current: string | null;
  readonly onOpen: (clipId: string) => void;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}

// The clip picker as cards with a title and one sentence on what each clip demonstrates.
export function ClipCards({ details, current, onOpen, onChanged, onClose }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [story, setStory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = (d: ClipDetail) => {
    setEditing(d.id);
    setTitle(d.title);
    setStory(d.story);
  };
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.updateInfo(editing, { title, story });
      setEditing(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (d: ClipDetail) => {
    if (!window.confirm(`Delete "${d.title}" and everything derived from it? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteClip(d.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cards-panel" role="dialog" aria-label="clips">
      <div className="upload-head">
        <h2>Clips</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      <div className="cards">
        {details.map((d) => (
          <div key={d.id} className={`card${d.id === current ? " current" : ""}`}>
            {editing === d.id ? (
              <div className="card-edit">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title" maxLength={80} />
                <textarea value={story} onChange={(e) => setStory(e.target.value)} placeholder="one sentence on what this clip shows" maxLength={300} rows={3} />
                <div className="mark-row">
                  <button type="button" onClick={() => void save()} disabled={busy}>
                    Save
                  </button>
                  <button type="button" className="link" onClick={() => setEditing(null)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h3>
                  <button type="button" className="link card-title" onClick={() => onOpen(d.id)}>
                    {d.title}
                  </button>
                </h3>
                <p className="muted">{d.story || "No description yet."}</p>
                <p className="card-meta">
                  {d.demo ? <span className="chip">demo, cached</span> : <span className="chip">uploaded</span>}{" "}
                  {d.analyzed ? <span className="chip ok">analyzed</span> : <span className="chip warn">not analyzed</span>} {d.durationS > 0 ? `${d.durationS.toFixed(0)} s` : ""}
                </p>
                <div className="mark-row">
                  <button type="button" onClick={() => onOpen(d.id)}>
                    Open
                  </button>
                  <button type="button" className="link" onClick={() => startEdit(d)}>
                    Edit title
                  </button>
                  {!d.demo ? (
                    <button type="button" className="link warn" onClick={() => void remove(d)} disabled={busy}>
                      Delete my clip
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
