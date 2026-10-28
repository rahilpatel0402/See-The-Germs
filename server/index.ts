// Express API. Keys stay here; the client never talks to Meta directly.
import "./env.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { complianceFrom, personMapper } from "../engine/compliance.ts";
import type { Analysis } from "../engine/types.ts";
import { readScenario, runAnalysis, runCounterfactualFor, validateScenario, writeScenario } from "./analysis.ts";
import { explainCounterfactual, narrateClip, readNarrative } from "./narrate.ts";
import { buildPipeline, parseScenarioOverride } from "./pipeline.ts";
import { createClipFromUpload, deleteClip, ensureClip, listClipIds, readMeta, updateClipInfo } from "./clips.ts";
import { optionalEnv } from "./env.ts";
import { readEntities, validateEntities, writeEntities } from "./entities.ts";
import { HttpError } from "./errors.ts";
import { withClipLock } from "./locks.ts";
import { analysisPath, clipDir, sampledPath, TMP_DIR } from "./paths.ts";
import { tracksPayload } from "./tracks.ts";
import { adjudicateClip } from "./adjudicate.ts";
import { BOX_PREFIX, deleteRemoteFile, MetaSamBackend, readTrack, segmentBox, segmentPhrase } from "./sam.ts";
import { proposeScene, slugId } from "./scene.ts";
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
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  next();
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Demo clips first, then everything else, so the picker opens on a cached clip. details carries
// what the clip cards show.
app.get("/api/clips", wrap(async (_req, res) => {
  const all = await listClipIds();
  const demo = DEMO_CLIPS.filter((id) => all.includes(id));
  const ordered = [...demo, ...all.filter((id) => !demo.includes(id))];
  const details = [];
  for (const id of ordered) {
    try {
      const meta = await readMeta(id);
      details.push({
        id,
        title: meta.title ?? id,
        story: meta.story ?? "",
        demo: demo.includes(id),
        analyzed: existsSync(analysisPath(id)),
        durationS: meta.sampled.frames / meta.fps,
        createdAt: meta.createdAt,
      });
    } catch {
      details.push({ id, title: id, story: "", demo: demo.includes(id), analyzed: false, durationS: 0, createdAt: "" });
    }
  }
  res.json({ clips: ordered, demo, details });
}));

// Title and story for the clip card. Allowed on demo clips too: it is presentation, not data.
app.put("/api/clips/:id/info", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  const body = (req.body ?? {}) as { title?: unknown; story?: unknown };
  const info = {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.story === "string" ? { story: body.story } : {}),
  };
  res.json({ clip: await updateClipInfo(meta.id, info) });
}));

// A caregiver's footage must be deletable on request. Demo clips are not deletable here.
app.delete("/api/clips/:id", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  assertEditable(meta.id);
  await withClipLock(meta.id, async () => {
    await deleteRemoteFile(meta).catch((err: Error) => console.log(`files   | ${meta.id} | remote delete failed: ${err.message}`));
    await deleteClip(meta.id);
  });
  console.log(`clips   | ${meta.id} | deleted on request`);
  res.json({ deleted: meta.id });
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

// The resampled video the masks were computed on, with range requests for seeking. A range
// request the browser abandons while scrubbing is not an error once bytes have gone out.
app.get("/api/clips/:id/video", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  await new Promise<void>((resolve, reject) => {
    res.sendFile(sampledPath(meta.id), { acceptRanges: true, cacheControl: false }, (err) => (err && !res.headersSent ? reject(err) : resolve()));
  });
}));

// The two annotated frames Spark saw for a reviewed candidate, n = 1 or 2.
app.get("/api/clips/:id/adjudication/:candidateId/:n.png", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  const candidateId = String(req.params["candidateId"]).replace(/[^A-Za-z0-9_-]/g, "_");
  const n = String(req.params["n"]);
  if (n !== "1" && n !== "2") throw new HttpError(400, "n must be 1 or 2");
  const file = path.join(clipDir(meta.id), "adjudication", `${candidateId}-${n}.png`);
  if (!existsSync(file)) throw new HttpError(404, "no annotated frame for this candidate");
  await new Promise<void>((resolve, reject) => {
    res.sendFile(file, { cacheControl: true, maxAge: "1d" }, (err) => (err && !res.headersSent ? reject(err) : resolve()));
  });
}));

const isDemo = (clipId: string): boolean => DEMO_CLIPS.includes(clipId);
function assertEditable(clipId: string): void {
  if (isDemo(clipId)) throw new HttpError(403, `${clipId} is a demo clip and is read only`);
}

app.get("/api/clips/:id/analysis", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  if (!existsSync(analysisPath(meta.id))) throw new HttpError(404, `clip ${meta.id} has not been analyzed yet`);
  res.type("json").send(await readFile(analysisPath(meta.id), "utf8"));
}));

app.get("/api/clips/:id/tracks", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  res.json(await tracksPayload(meta.id));
}));

// Track an object from a box drawn on one frame: SAM follows it forward and backward, the
// entity joins entities.json, and the analysis is rerun. Body: { frameIndex, box, label, kind,
// zone, agent?, entityId? (to redo an existing one) }.
app.post("/api/clips/:id/track-box", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  assertEditable(meta.id);
  const body = (req.body ?? {}) as { frameIndex?: unknown; box?: { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown }; label?: unknown; kind?: unknown; zone?: unknown; agent?: unknown; entityId?: unknown };
  const frameIndex = Number(body.frameIndex);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= meta.sampled.frames) throw new HttpError(400, `frameIndex must be 0 to ${meta.sampled.frames - 1}`);
  const b = body.box ?? {};
  const box = { left: Math.floor(Number(b.left)), top: Math.floor(Number(b.top)), right: Math.ceil(Number(b.right)), bottom: Math.ceil(Number(b.bottom)) };
  if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite) || box.left < 0 || box.top < 0 || box.right > meta.sampled.width || box.bottom > meta.sampled.height || box.right - box.left < 4 || box.bottom - box.top < 4) {
    throw new HttpError(400, "box must be inside the frame and at least 4 px on each side");
  }
  const label = String(body.label ?? "").trim();
  if (!label) throw new HttpError(400, "label is required");
  const entities = await readEntities(meta.id);
  const used = new Set(entities.map((e) => e.id));
  const entityId = typeof body.entityId === "string" && used.has(body.entityId) ? body.entityId : slugId(label, used);
  const draft = {
    id: entityId,
    label,
    class: String(body.kind ?? "object"),
    zone: String(body.zone ?? "healthcare_area"),
    samPhrase: `${BOX_PREFIX}${entityId}`,
    ...(typeof body.agent === "string" && body.agent ? { agent: body.agent } : {}),
  };
  const next = [...entities.filter((e) => e.id !== entityId), draft];
  try {
    validateEntities(next);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const track = await withClipLock(meta.id, async () => {
    const t = await segmentBox(meta.id, entityId, { frameIndex, box, direction: "both" }, backend);
    // The box call re-uploads the clip; it does not need to stay on the Meta side.
    await deleteRemoteFile(await readMeta(meta.id)).catch((err: Error) => console.log(`files   | ${meta.id} | remote delete failed: ${err.message}`));
    if (t) await writeEntities(meta.id, next);
    return t;
  });
  if (!track) throw new HttpError(422, "SAM could not track anything from that box; try a tighter box on a clearer frame");
  const frames = new Set(track.records.map((r) => r.frameIndex)).size;
  const analysis = existsSync(analysisPath(meta.id)) ? await runAnalysis(meta.id) : null;
  res.json({ entity: next.find((e) => e.id === entityId), frames, objects: new Set(track.records.map((r) => r.objectId)).size, analysis });
}));

// Spark proposes the prop table from three frames, SAM verifies every phrase. Writes entities.json.
app.post("/api/clips/:id/scene", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  assertEditable(meta.id);
  res.json(await withClipLock(meta.id, () => proposeScene(meta.id, spark)));
}));

app.put("/api/clips/:id/entities", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  assertEditable(meta.id);
  const entities: unknown = req.body;
  try {
    validateEntities(entities);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  await writeEntities(meta.id, entities);
  res.json({ entities });
}));

// Runs SAM for every entity phrase that has no cached track yet. Idempotent. With ?stream=1
// the response is newline-delimited JSON, one object per class as it completes, then
// { done: true }, so the upload flow can show progress.
app.post("/api/segment", wrap(async (req, res) => {
  const clipId = String((req.body as { clipId?: unknown })?.clipId ?? "");
  const meta = await readMeta(clipId);
  const entities = await readEntities(meta.id);
  const phrases = [...new Set(entities.map((e) => e.samPhrase))];
  // Demo clips are served from cache and never spend credit.
  if (isDemo(meta.id)) {
    for (const phrase of phrases) if (!(await readTrack(meta.id, phrase))) throw new HttpError(403, `${meta.id} is a demo clip; "${phrase}" is not cached and will not be segmented live`);
  }
  const stream = req.query["stream"] === "1";
  if (stream) {
    res.status(200).type("application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
  }
  const summary: Array<{ phrase: string; frames: number; objects: number; billedFrames: number | null; ms: number }> = [];
  try {
    // One segmentation at a time per clip: a second request waits and then finds the cache.
    await withClipLock(meta.id, async () => {
      for (const phrase of phrases) {
        const started = Date.now();
        const track = await segmentPhrase(meta.id, phrase, backend);
        const line = {
          phrase,
          frames: new Set(track.records.map((r) => r.frameIndex)).size,
          objects: new Set(track.records.map((r) => r.objectId)).size,
          billedFrames: track.usage.videoFramesProcessed ?? null,
          ms: Date.now() - started,
        };
        summary.push(line);
        if (stream) res.write(`${JSON.stringify(line)}\n`);
      }
    });
  } catch (err) {
    if (!stream) throw err;
    res.write(`${JSON.stringify({ error: (err as Error).message })}\n`);
    res.end();
    return;
  }
  // Every class is cached now, so the clip does not need to stay on the Meta side.
  await deleteRemoteFile(await readMeta(meta.id)).catch((err: Error) => console.log(`files   | ${meta.id} | remote delete failed: ${err.message}`));
  if (stream) {
    res.write(`${JSON.stringify({ done: true, clipId: meta.id })}\n`);
    res.end();
  } else {
    res.json({ clipId: meta.id, tracks: summary });
  }
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

// Hand hygiene compliance across several analyzed clips (a session), as JSON or CSV rows of
// every opportunity. ?clips=A,B,C
async function sessionOpportunities(clipsParam: unknown): Promise<Array<{ clipId: string; analysis: Analysis }>> {
  const ids = String(clipsParam ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new HttpError(400, "clips is required, comma separated");
  const out: Array<{ clipId: string; analysis: Analysis }> = [];
  for (const id of ids) {
    const meta = await readMeta(id);
    if (!existsSync(analysisPath(meta.id))) throw new HttpError(409, `clip ${meta.id} has not been analyzed yet`);
    const analysis = JSON.parse(await readFile(analysisPath(meta.id), "utf8")) as Partial<Analysis>;
    // An analysis written before the compliance fields existed must be rerun, not guessed at.
    if (!Array.isArray(analysis.opportunities) || !analysis.compliance || !analysis.cleaning || !Array.isArray(analysis.gloveIssues)) {
      throw new HttpError(409, `clip ${meta.id} was analyzed by an older version; run the analysis again`);
    }
    out.push({ clipId: meta.id, analysis: analysis as Analysis });
  }
  return out;
}

app.get("/api/compliance", wrap(async (req, res) => {
  const session = await sessionOpportunities(req.query["clips"]);
  const all = session.flatMap((s) => s.analysis.opportunities);
  const mapper = personMapper(session.flatMap((s) => s.analysis.entities));
  // Surfaces contaminated across the session, by label, with contacts while contaminated summed.
  const surfaces = new Map<string, { label: string; clips: number; contacts: number }>();
  for (const s of session) {
    for (const item of s.analysis.cleaning.items) {
      const cur = surfaces.get(item.label) ?? { label: item.label, clips: 0, contacts: 0 };
      cur.clips++;
      cur.contacts += item.contactCount;
      surfaces.set(item.label, cur);
    }
  }
  res.json({
    clips: session.map((s) => ({
      clipId: s.clipId,
      pathogen: s.analysis.pathogen.label,
      score: s.analysis.score,
      compliance: s.analysis.compliance,
      momentMisses: s.analysis.momentMisses.map((m) => ({ moment: m.moment, t: m.t })),
      gloveIssues: s.analysis.gloveIssues.map((g) => ({ type: g.type, t: g.t })),
      hygiene: { events: s.analysis.hygieneEvents.length, adequate: s.analysis.hygieneEvents.filter((h) => h.adequate).length, effective: s.analysis.hygieneEvents.filter((h) => h.effective).length },
      residentExposures: s.analysis.propagation.residentExposures.length,
      surfaces: s.analysis.cleaning.items.map((i) => i.label),
    })),
    session: complianceFrom(all, mapper),
    surfaces: [...surfaces.values()].sort((a, b) => b.contacts - a.contacts || b.clips - a.clips),
  });
}));

app.get("/api/compliance.csv", wrap(async (req, res) => {
  const session = await sessionOpportunities(req.query["clips"]);
  const rows = ["clip,person,moment,time_s,met,pathogen"];
  for (const s of session) {
    const person = personMapper(s.analysis.entities);
    for (const o of s.analysis.opportunities) rows.push(`${s.clipId},${person(o.handId)},${o.moment},${o.t.toFixed(1)},${o.met ? "yes" : "no"},${s.analysis.pathogen.label}`);
  }
  res.type("text/csv").setHeader("Content-Disposition", "attachment; filename=hand-hygiene-opportunities.csv").send(rows.join("\n"));
}));

// The cached narrative for the clip's current analysis (query pathogen and sourceEntityId
// select a scenario); 404 until generated for exactly that analysis.
app.get("/api/clips/:id/narrative", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  const { analysis } = await buildPipeline(meta.id, parseScenarioOverride(req.query as { pathogen?: unknown; sourceEntityId?: unknown }));
  const language = req.query["language"] === "es" ? "es" : "en";
  const file = await readNarrative(meta.id, analysis, language);
  if (!file) throw new HttpError(404, `clip ${meta.id} has no narrative for this scenario yet`);
  res.json(file);
}));

// Generates the narrative for the clip's current analysis (cached by input hash and language).
app.post("/api/narrate", wrap(async (req, res) => {
  const body = (req.body ?? {}) as { clipId?: unknown; pathogen?: unknown; sourceEntityId?: unknown; language?: unknown };
  const clipId = String(body.clipId ?? "");
  await readMeta(clipId);
  const language = body.language === "es" ? "es" : "en";
  const analysis = await runAnalysis(clipId, parseScenarioOverride(body));
  res.json(await narrateClip(clipId, analysis, spark, language));
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
  const run = await withClipLock(clipId, () => adjudicateClip(clipId, spark));
  const analysis = await runAnalysis(clipId);
  res.json({ added: run.added, failed: run.failed, skipped: run.plan.skipped.map((c) => c.id), adjudications: run.all, analysis });
}));

app.get("/api/clips/:id/scenario", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  res.json({ scenario: await readScenario(meta.id) });
}));

app.put("/api/clips/:id/scenario", wrap(async (req, res) => {
  const meta = await readMeta(String(req.params["id"]));
  assertEditable(meta.id);
  const entities = await readEntities(meta.id);
  const scenario = validateScenario(req.body, entities);
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
  if (res.headersSent) {
    res.destroy();
    return;
  }
  let status = err instanceof HttpError ? err.status : 500;
  let message = err instanceof Error ? err.message : "unknown error";
  if (err instanceof multer.MulterError) {
    status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message = err.code === "LIMIT_FILE_SIZE" ? `the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB` : err.message;
  }
  if (status === 500) console.error(err);
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`server  | listening on http://localhost:${PORT}`);
});
