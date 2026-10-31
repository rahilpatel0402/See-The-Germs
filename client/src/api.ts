// Typed fetchers for the server. The client never holds a model key and never calls Meta directly.
import type { Analysis, Counterfactual, Entity, HygieneAgent, MaskRecord, Narrative, PathogenId } from "../../engine/types.ts";

export interface NarrativeFile {
  readonly hash: string;
  readonly model: string;
  readonly backend: string;
  readonly createdAt: string;
  readonly narrative: Narrative;
}

export interface ScenarioOverride {
  readonly pathogen?: PathogenId;
  readonly sourceEntityId?: string;
}

export interface TracksPayload {
  readonly frameSize: { readonly w: number; readonly h: number };
  readonly fps: number;
  readonly frames: number;
  readonly entities: readonly Entity[];
  readonly tracks: Readonly<Record<string, readonly MaskRecord[]>>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface EntityConfig extends Entity {
  readonly minConfidence?: number;
}

export interface ClipInfo {
  readonly clip: { readonly id: string; readonly source: { readonly durationS: number; readonly width: number; readonly height: number }; readonly sampled: { readonly frames: number } };
  readonly entities: EntityConfig[];
}

export interface SegmentLine {
  readonly phrase?: string;
  readonly frames?: number;
  readonly objects?: number;
  readonly billedFrames?: number | null;
  readonly ms?: number;
  readonly done?: boolean;
  readonly error?: string;
}

export interface AdjudicateResult {
  readonly added: Array<{ candidateId: string; verdict: string; reasoning: string }>;
  readonly failed: Array<{ candidateId: string; reason: string }>;
  readonly skipped: string[];
  readonly analysis: Analysis;
}

// Multipart upload with progress, which fetch cannot report.
export function uploadClip(file: File, onProgress: (fraction: number) => void): Promise<ClipInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/clips");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, "upload failed; check the connection"));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as ClipInfo);
      else reject(new ApiError(xhr.status, (body as { error?: string })?.error ?? xhr.statusText));
    };
    const form = new FormData();
    form.append("video", file, file.name);
    xhr.send(form);
  });
}

// Reads the newline-delimited progress stream from POST /api/segment?stream=1.
export async function segmentStream(clipId: string, onLine: (line: SegmentLine) => void): Promise<void> {
  const res = await fetch("/api/segment?stream=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipId }),
  });
  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // keep statusText
    }
    throw new ApiError(res.status, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (raw) {
        const line = JSON.parse(raw) as SegmentLine;
        if (line.error) throw new ApiError(500, line.error);
        onLine(line);
      }
      nl = buffer.indexOf("\n");
    }
  }
}

export interface SceneResult {
  readonly entities: EntityConfig[];
  readonly report: Array<{
    id: string;
    label: string;
    tried: Array<{ phrase: string; objects: number; meanConfidence: number | null }>;
    chosen: string | null;
    verified: boolean;
    // Set when SAM resolved this prop to the same object as an earlier one; it was not added.
    mergedInto?: string;
    // A plain-language note about a change the loop made, for example a dispenser kept as a surface.
    note?: string;
  }>;
  readonly frames: number[];
  readonly cost: number;
}

export interface TrackBoxRequest {
  readonly frameIndex: number;
  readonly box: { left: number; top: number; right: number; bottom: number };
  readonly label: string;
  readonly kind: "object" | "resident_zone" | "dispenser";
  readonly zone: string;
  readonly agent?: string;
}

export interface SessionClip {
  readonly clipId: string;
  readonly pathogen: string;
  readonly score: { score: number; contaminatedSurfaces: number; chainLength: number };
  readonly compliance: { overall: { opportunities: number; met: number; rate: number | null }; byMoment: Record<"1" | "2" | "4" | "5", { opportunities: number; met: number; rate: number | null }> };
  readonly momentMisses: Array<{ moment: number; t: number }>;
  readonly gloveIssues: Array<{ type: string; t: number }>;
  readonly hygiene: { events: number; adequate: number; effective: number };
  readonly residentExposures: number;
  readonly surfaces: string[];
}

export interface SessionReport {
  readonly clips: SessionClip[];
  readonly session: { overall: { opportunities: number; met: number; rate: number | null }; byMoment: Record<"1" | "2" | "4" | "5", { opportunities: number; met: number; rate: number | null }>; byPerson: Record<string, { opportunities: number; met: number; rate: number | null }> };
  readonly surfaces: Array<{ label: string; clips: number; contacts: number }>;
}

export interface ClipDetail {
  readonly id: string;
  readonly title: string;
  readonly story: string;
  readonly demo: boolean;
  readonly analyzed: boolean;
  readonly durationS: number;
  readonly createdAt: string;
}

export type NarrativeLanguage = "en" | "es";

export const api = {
  clips: () => request<{ clips: string[]; demo: string[]; details: ClipDetail[] }>("/api/clips"),
  updateInfo: (clipId: string, info: { title?: string; story?: string }) =>
    request<{ clip: unknown }>(`/api/clips/${encodeURIComponent(clipId)}/info`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(info) }),
  deleteClip: (clipId: string) => request<{ deleted: string }>(`/api/clips/${encodeURIComponent(clipId)}`, { method: "DELETE" }),
  session: (clipIds: readonly string[]) => request<SessionReport>(`/api/compliance?clips=${encodeURIComponent(clipIds.join(","))}`),
  sessionCsvUrl: (clipIds: readonly string[]) => `/api/compliance.csv?clips=${encodeURIComponent(clipIds.join(","))}`,
  trackBox: (clipId: string, body: TrackBoxRequest) =>
    post<{ entity: EntityConfig; frames: number; objects: number; analysis: Analysis | null }>(`/api/clips/${encodeURIComponent(clipId)}/track-box`, body),
  scene: (clipId: string) => post<SceneResult>(`/api/clips/${encodeURIComponent(clipId)}/scene`, {}),
  clip: (clipId: string) => request<ClipInfo>(`/api/clips/${encodeURIComponent(clipId)}`),
  saveEntities: (clipId: string, entities: readonly EntityConfig[]) =>
    request<{ entities: EntityConfig[] }>(`/api/clips/${encodeURIComponent(clipId)}/entities`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entities),
    }),
  adjudicate: (clipId: string) => post<AdjudicateResult>("/api/adjudicate", { clipId }),
  tracks: (clipId: string) => request<TracksPayload>(`/api/clips/${encodeURIComponent(clipId)}/tracks`),
  analysis: (clipId: string) => request<Analysis>(`/api/clips/${encodeURIComponent(clipId)}/analysis`),
  analyze: (clipId: string, override?: ScenarioOverride) => post<Analysis>("/api/analyze", { clipId, ...override }),
  counterfactual: (clipId: string, t: number, agent: HygieneAgent, handId: string | undefined, override?: ScenarioOverride) =>
    post<Counterfactual>("/api/counterfactual", { clipId, t, agent, ...(handId ? { handId } : {}), ...override }),
  explainCounterfactual: (clipId: string, t: number, agent: HygieneAgent, handId: string | undefined, override?: ScenarioOverride) =>
    post<{ explanation: string }>("/api/counterfactual/explain", { clipId, t, agent, ...(handId ? { handId } : {}), ...override }),
  narrative: (clipId: string, scenario?: ScenarioOverride, language: NarrativeLanguage = "en") => {
    const q = new URLSearchParams();
    if (scenario?.pathogen) q.set("pathogen", scenario.pathogen);
    if (scenario?.sourceEntityId) q.set("sourceEntityId", scenario.sourceEntityId);
    if (language !== "en") q.set("language", language);
    const qs = q.toString();
    return request<NarrativeFile>(`/api/clips/${encodeURIComponent(clipId)}/narrative${qs ? `?${qs}` : ""}`);
  },
  narrate: (clipId: string, override?: ScenarioOverride, language: NarrativeLanguage = "en") => post<NarrativeFile>("/api/narrate", { clipId, language, ...override }),
  videoUrl: (clipId: string) => `/api/clips/${encodeURIComponent(clipId)}/video`,
};

function post<T>(url: string, body: object): Promise<T> {
  return request<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
