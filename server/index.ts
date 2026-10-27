// Express API. Keys stay here; the client never talks to Meta directly.
import "./env.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { readScenario, runAnalysis, runCounterfactualFor, validateScenario, writeScenario } from "./analysis.ts";
import { explainCounterfactual, narrateClip, readNarrative } from "./narrate.ts";
import { buildPipeline, parseScenarioOverride } from "./pipeline.ts";
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
// Heuristic caps so a judge cannot burn the credit budget: 45 s per upload, a daily upload
// count, and the adjudication cap in engine/config.ts.
const MAX_UPLOAD_SECONDS = 45;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_UPLOADS_PER_DAY = Number(optionalEnv("MAX_UPLOADS_PER_DAY", "20"));
// Comma-separated clip ids that are precomputed and served offline from cache.
const DEMO_CLIPS = optionalEnv("DEMO_CLIPS", "").split(",").map((s) => s.trim()).filter(Boolean);
const CLIENT_DIST = path.join(process.cwd(), "client", "dist");

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

// Demo clips first, then everything else, so the picker opens on a cached clip.
app.get("/api/clips", wrap(async (_req, res) => {
  const all = await listClipIds();
  const demo = DEMO_CLIPS.filter((id) => all.includes(id));
  res.json({ clips: [...demo, ...all.filter((id) => !demo.includes(id))], demo });
}));

app.get("/api/demo", wrap(async (_req, res) => {
  const all = await listClipIds();
  res.json({ demo: DEMO_CLIPS.filter((id) => all.includes(id) && existsSync(analysisPath(id))) });
}));

async function uploadsToday(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const id of await listClipIds()) {
    if (!id.startsWith("c_")) continue;
    try {
      const meta = await readMeta(id);
      if (meta.createdAt.startsWith(today)) n++;
    } catch {
      // unreadable clip folders do not count
    }
  }
  return n;
}

app.post("/api/clips", upload.single("video"), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, "send the video as multipart field 'video'");
  if ((await uploadsToday()) >= MAX_UPLOADS_PER_DAY) {
    await rm(req.file.path, { force: true });
    throw new HttpError(429, `the daily upload limit of ${MAX_UPLOADS_PER_DAY} clips is reached; the demo clips still work`);
  }
  const meta = await createClipFromUpload(req.file.path, req.file.originalname, MAX_UPLOAD_SECONDS);
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

// The cached narrative for the clip's current analysis (query pathogen and sourceEntityId
// select a scenario); 404 until generated for exactly that analysis.
app.get("/api/clips/:id/narrative", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  const { analysis } = await buildPipeline(meta.id, parseScenarioOverride(req.query as { pathogen?: unknown; sourceEntityId?: unknown }));
  const file = await readNarrative(meta.id, analysis);
  if (!file) throw new HttpError(404, `clip ${meta.id} has no narrative for this scenario yet`);
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

// Two sentences on one counterfactual, cached per clip, scenario, time, and agent.
app.post("/api/counterfactual/explain", wrap(async (req, res) => {
  const body = (req.body ?? {}) as { clipId?: unknown; t?: unknown; handId?: unknown; agent?: unknown; pathogen?: unknown; sourceEntityId?: unknown };
  const clipId = String(body.clipId ?? "");
  await readMeta(clipId);
  const override = parseScenarioOverride(body);
  const pipeline = await buildPipeline(clipId, override);
  const insert = {
    t: Number(body.t),
    ...(typeof body.handId === "string" ? { handId: body.handId } : {}),
    ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
  };
  const cf = await runCounterfactualFor(clipId, insert, override, pipeline);
  const file = await explainCounterfactual(pipeline.analysis, cf, spark);
  res.json({ explanation: file.explanation, cached: file });
}));

// Sends ambiguous candidates to Spark vision (cached, capped) and returns the fresh analysis.
app.post("/api/adjudicate", wrap(async (req, res) => {
  const clipId = String((req.body as { clipId?: unknown })?.clipId ?? "");
  await readMeta(clipId);
  const run = await adjudicateClip(clipId, spark);
  const analysis = await runAnalysis(clipId);
  res.json({ added: run.added, failed: run.failed, skipped: run.plan.skipped.map((c) => c.id), adjudications: run.all, analysis });
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

// In production the built client is served from the same process, so one deploy is enough.
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "unknown error";
  if (status === 500) console.error(err);
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`server  | listening on http://localhost:${PORT}`);
});
