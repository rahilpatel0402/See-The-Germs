// Express API. Keys stay here; the client never talks to Meta directly.
import "./env.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { readScenario, runAnalysis, runCounterfactualFor, validateScenario, writeScenario } from "./analysis.ts";
import { explainCounterfactual, narrateClip, readNarrative } from "./narrate.ts";
import { parseScenarioOverride } from "./pipeline.ts";
import { createClipFromUpload, ensureClip, listClipIds, readMeta } from "./clips.ts";
import { optionalEnv } from "./env.ts";
import { readEntities, validateEntities, writeEntities } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { analysisPath, sampledPath, TMP_DIR } from "./paths.ts";
import { tracksPayload } from "./tracks.ts";
import { adjudicateClip } from "./adjudicate.ts";
import { MetaSamBackend, segmentPhrase } from "./sam.ts";
import { MetaSparkBackend } from "./spark.ts";

const PORT = Number(optionalEnv("PORT", "8787"));
// Heuristic cap so a judge cannot burn the credit budget with one upload: 45 s of video.
const MAX_UPLOAD_SECONDS = 45;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

await mkdir(TMP_DIR, { recursive: true });
const app = express();
const upload = multer({ dest: TMP_DIR, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
const backend = new MetaSamBackend();
const spark = new MetaSparkBackend();

app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", optionalEnv("CLIENT_ORIGIN", "*"));
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  next();
});
app.options("/{*path}", (_req, res) => res.sendStatus(204));

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/clips", wrap(async (_req, res) => {
  res.json({ clips: await listClipIds() });
}));

app.post("/api/clips", upload.single("video"), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, "send the video as multipart field 'video'");
  const meta = await createClipFromUpload(req.file.path, req.file.originalname);
  if (meta.source.durationS > MAX_UPLOAD_SECONDS) {
    throw new HttpError(413, `clip is ${meta.source.durationS.toFixed(1)} s; the limit is ${MAX_UPLOAD_SECONDS} s`);
  }
  res.status(201).json({ clip: meta, entities: await readEntities(meta.id) });
}));

app.get("/api/clips/:id", wrap(async (req, res) => {
  const meta = await ensureClip(String(req.params["id"]));
  res.json({ clip: meta, entities: await readEntities(meta.id) });
}));

// The resampled video the masks were computed on, with range requests for seeking.
app.get("/api/clips/:id/video", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  await new Promise<void>((resolve, reject) => {
    res.sendFile(sampledPath(meta.id), { acceptRanges: true, cacheControl: false }, (err) => (err ? reject(err) : resolve()));
  });
}));

app.get("/api/clips/:id/analysis", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  if (!existsSync(analysisPath(meta.id))) throw new HttpError(404, `clip ${meta.id} has not been analyzed yet`);
  res.type("json").send(await readFile(analysisPath(meta.id), "utf8"));
}));

app.get("/api/clips/:id/tracks", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  res.json(await tracksPayload(meta.id));
}));

app.put("/api/clips/:id/entities", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  const entities: unknown = req.body;
  try {
    validateEntities(entities);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  await writeEntities(meta.id, entities);
  res.json({ entities });
}));

// Runs SAM for every entity phrase that has no cached track yet. Idempotent.
app.post("/api/segment", wrap(async (req, res) => {
  const clipId = String((req.body as { clipId?: unknown })?.clipId ?? "");
  const meta = await readMeta(clipId);
  const entities = await readEntities(meta.id);
  const phrases = [...new Set(entities.map((e) => e.samPhrase))];
  const summary = [];
  for (const phrase of phrases) {
    const track = await segmentPhrase(meta.id, phrase, backend);
    summary.push({
      phrase,
      frames: new Set(track.records.map((r) => r.frameIndex)).size,
      objects: new Set(track.records.map((r) => r.objectId)).size,
      billedFrames: track.usage.videoFramesProcessed ?? null,
    });
  }
  res.json({ clipId: meta.id, tracks: summary });
}));

// Body: { clipId, pathogen?, sourceEntityId? }. Overrides apply to this run only; use PUT
// /api/clips/:id/scenario to change the stored scenario.
app.post("/api/analyze", wrap(async (req, res) => {
  const body = (req.body ?? {}) as { clipId?: unknown; pathogen?: unknown; sourceEntityId?: unknown };
  const clipId = String(body.clipId ?? "");
  await readMeta(clipId);
  res.json(await runAnalysis(clipId, parseScenarioOverride(body)));
}));

// Body: { clipId, t, handId?, agent?, pathogen?, sourceEntityId? }. Pure rerun, no model call.
app.post("/api/counterfactual", wrap(async (req, res) => {
  const body = (req.body ?? {}) as { clipId?: unknown; t?: unknown; handId?: unknown; agent?: unknown; pathogen?: unknown; sourceEntityId?: unknown };
  const clipId = String(body.clipId ?? "");
  await readMeta(clipId);
  const insert = {
    t: Number(body.t),
    ...(typeof body.handId === "string" ? { handId: body.handId } : {}),
    ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
  };
  res.json(await runCounterfactualFor(clipId, insert, parseScenarioOverride(body)));
}));

// Cached narrative only; 404 until generated.
app.get("/api/clips/:id/narrative", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  const file = await readNarrative(meta.id);
  if (!file) throw new HttpError(404, `clip ${meta.id} has no narrative yet`);
  res.json(file);
}));

// Generates the narrative for the clip's current analysis (cached by input hash).
app.post("/api/narrate", wrap(async (req, res) => {
  const body = (req.body ?? {}) as { clipId?: unknown; pathogen?: unknown; sourceEntityId?: unknown };
  const clipId = String(body.clipId ?? "");
  await readMeta(clipId);
  const analysis = await runAnalysis(clipId, parseScenarioOverride(body));
  res.json(await narrateClip(clipId, analysis, spark));
}));

// Two sentences on one counterfactual, on demand.
app.post("/api/counterfactual/explain", wrap(async (req, res) => {
  const body = (req.body ?? {}) as { clipId?: unknown; t?: unknown; handId?: unknown; agent?: unknown; pathogen?: unknown; sourceEntityId?: unknown };
  const clipId = String(body.clipId ?? "");
  await readMeta(clipId);
  const override = parseScenarioOverride(body);
  const analysis = await runAnalysis(clipId, override);
  const insert = {
    t: Number(body.t),
    ...(typeof body.handId === "string" ? { handId: body.handId } : {}),
    ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
  };
  const cf = await runCounterfactualFor(clipId, insert, override);
  res.json({ explanation: await explainCounterfactual(analysis, cf, spark) });
}));

// Sends ambiguous candidates to Spark vision (cached, capped) and returns the fresh analysis.
app.post("/api/adjudicate", wrap(async (req, res) => {
  const clipId = String((req.body as { clipId?: unknown })?.clipId ?? "");
  await readMeta(clipId);
  const run = await adjudicateClip(clipId, spark);
  const analysis = await runAnalysis(clipId);
  res.json({ added: run.added, skipped: run.plan.skipped.map((c) => c.id), adjudications: run.all, analysis });
}));

app.get("/api/clips/:id/scenario", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  res.json({ scenario: await readScenario(meta.id) });
}));

app.put("/api/clips/:id/scenario", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  const entities = await readEntities(meta.id);
  const scenario = validateScenario(req.body, new Set(entities.map((e) => e.id)));
  await writeScenario(meta.id, scenario);
  res.json({ scenario });
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "unknown error";
  if (status === 500) console.error(err);
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`server  | listening on http://localhost:${PORT}`);
});
