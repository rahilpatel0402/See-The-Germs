// Typed fetchers for the server. The client never holds a model key and never calls Meta directly.
import type { Analysis, Entity, MaskRecord, PathogenId } from "../../engine/types.ts";

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

export const api = {
  clips: () => request<{ clips: string[] }>("/api/clips"),
  tracks: (clipId: string) => request<TracksPayload>(`/api/clips/${encodeURIComponent(clipId)}/tracks`),
  analysis: (clipId: string) => request<Analysis>(`/api/clips/${encodeURIComponent(clipId)}/analysis`),
  analyze: (clipId: string, override?: { pathogen?: PathogenId; sourceEntityId?: string }) =>
    request<Analysis>("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipId, ...override }),
    }),
  videoUrl: (clipId: string) => `/api/clips/${encodeURIComponent(clipId)}/video`,
};
