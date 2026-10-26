# CLAUDE.md: working rules for See the Germs

Read PLAN.md for what we are building and SCHEDULE.md for what today's gate is. Ask which gate we are on before starting work.

## Who you are working with
Rahil: physician turned clinical informatics builder. Ships React/TypeScript/Express apps in production. Not a Python developer. Knows infection control and nursing home workflows better than you do; when clinical rules are ambiguous, ask him, do not guess.

## Stack, fixed
- Client: React + Vite + TypeScript. Plain CSS or a single small CSS file. No component library unless already installed.
- Server: Express + TypeScript (tsx for dev). ffmpeg and ffprobe via child_process.
- Engine: pure TypeScript under `engine/`, no I/O, no framework, tests with `node:test` only.
- Models: Meta Model API only, base URL `https://api.meta.ai/v1`, bearer `MODEL_API_KEY`, called through the `openai` npm package (Responses API). SAM 3.1 (`sam-3.1`, clips uploaded once via `/v1/files`) for segmentation and tracking (including separate "bare hand" and "gloved hand" classes). Muse Spark 1.3 (`muse-spark-1.3`, Standard mode, never the contributor variant) in two roles: text (narrative from structured JSON) and vision (adjudicating ambiguous contact candidates from two annotated frames). Keys live in server `.env`, never in the client, never committed.
- Fallback segmentation backend: fal.ai SAM 3.1 video via its JS SDK, behind the same `SegmentationBackend` interface. Do not add it unless the Meta endpoint fails the feasibility gate.
- Second LLM backend, after Gate 7 only: Muse Spark Open on Baseten (`meta-models/muse-spark-open-1026`, OpenAI-style chat completions with vision) behind the same `SparkBackend` interface as Meta Model API, selected by `SPARK_BACKEND=meta|baseten`. Same prompts, same schemas, same caching. Meta Model API stays the default.

## Hard no
- No Python. If a task seems to need it, say so and propose the TypeScript route.
- No auth, no Docker, no database, no ORM, no Redux, no testing framework beyond node:test, no monorepo tooling.
- No em dashes or en dashes anywhere: code comments, UI copy, README, commit messages. Use commas, colons, or periods.
- No fabricated clinical facts. Pathogen rules come from `engine/pathogens.ts` and are cited in the README to CDC and WHO sources. Do not add a pathogen or change an effectiveness rule without Rahil confirming it.
- No LLM in the clinical decision loop. Muse Spark text explains the analysis; it never produces, edits, or overrides contacts, transfers, moments, or scores. Muse Spark vision votes only on perception edge cases the engine has flagged as ambiguous (touching, passing in front, unclear); it never sees confident contacts, hygiene events, glove events, or clinical rules, its verdicts are cached as input, capped per clip, and every adjudicated event is visibly marked in the UI.
- No scope creep past the ladder in SCHEDULE.md. Clip D and self-hosted Glimmer are cut. After Gate 7 the only additions are the Spark Open backend, then the exemplar box tool, in that order. If a new idea appears, write it in `docs/LATER.md` and keep going.
- No real patient data and no real footage of real facilities. Every clip is staged. Every clip view shows the synthetic data badge.
- No medical advice, anywhere. The product never diagnoses, treats, or advises a patient, and never recommends a clinical action for a person. Coaching notes are workplace hand-hygiene practice feedback for staff, grounded in WHO Five Moments and CDC guidance. If a prompt or UI string drifts toward patient-facing or clinical recommendation, stop and rewrite it. The hackathon bans medical-advice projects and this must be unmistakable to a judge in Stage One.
- No reused code. Everything in this repo is written during the hackathon (Oct 26 to Nov 4). Do not copy utilities, prompts, components, or configs from any of Rahil's other projects, even trivial ones. The rules require new work only and the demo may show only hackathon-built features.

## How to work
- Smallest change that meets the gate. Then stop and show it.
- Before writing a new module, state its input and output types in one paragraph and wait for a yes.
- Engine first, UI second. A rule that is not covered by a node:test case is not done.
- Cache every model call to disk under `data/clips/<id>/`. Never call SAM for a clip that already has tracks. The three demo clips must work offline from cache.
- Deterministic everything: same clip, same adjudications, same scenario, same pathogen, same output. The engine is a pure function and never calls a model. If you need randomness for anything, you are wrong.
- Accuracy is measured, not asserted. `labels.json` per clip is the ground truth; `npm run accuracy` reports precision and recall with a 1.0 s tolerance and lists every miss and false alarm. Do not tune a threshold without rerunning it.
- The standard is first place. When two implementations both meet the gate, pick the one the winning project would have shipped, and say which it is.
- When something is a heuristic (dwell, dilation, score weights), put the constant in `engine/config.ts` with a one-line comment saying it is a heuristic and why.
- Log clearly: one line per SAM call with class, frames, duration, cost estimate if available.
- Request shapes come from the official docs and the `meta-models/meta-model-cookbook` notebooks (structured output, vision input, prompt caching, error handling, SAM). Read them for the shape; never copy their code into this repo, it is Python and the rules require our own new work.
- Two reference repos are cloned read-only outside this project at `C:\dev\reference\meta-model-cookbook` and `C:\dev\reference\meta-oss-cookbook`. When you need a request or response shape for Meta Model API, SAM 3.1, Muse Spark, or Muse Spark Open, read the relevant notebook there by full path. The notebooks are Python; use them only to learn the shape, then write our own TypeScript. Never copy, import, or vendor any file from those folders into this repo, and never reference them from code or config.
- When blocked for more than 20 minutes on a sponsor API, write the exact request, response, and error into `docs/API_NOTES.md` and propose the fallback.

## Definitions you must use consistently
- Entity: hand, object, resident zone, dispenser. Each has an id, a class, a zone tag (patient_zone_A, patient_zone_B, healthcare_area, hygiene_station).
- Contact candidate: {handId, entityId, startT, endT, confidence: "confident" | "ambiguous"}.
- Adjudication: {candidateId, verdict: "touching" | "passing_in_front" | "unclear", reasoning: string}. Cached in `adjudications.json`.
- Contact event: {handId, entityId, startT, endT, adjudicated: boolean}. Confident candidates become contacts directly; ambiguous ones become contacts only with verdict touching or unclear.
- Transfer edge: {fromId, toId, t}. Recorded only when the recipient was clean.
- Hygiene event: {handId, t, agent: "alcohol_rub" | "soap_water", effective: boolean}.
- Glove event: {handId, t, type: "don" | "doff", source: "detected" | "manual"}. Detected from gloved-hand and bare-hand track handover; manual only under the fallback flag.
- Moment miss: {moment: 1 | 2 | 4 | 5, handId, t, downstream: entityId[]}.
- Analysis: the full output object; its schema lives in `engine/types.ts` and does not change without updating the Muse Spark prompt and the client in the same commit.

## Copy and tone in the UI
- Respectful toward caregivers. The product teaches; it does not accuse. Coaching notes are second person and name one change.
- Plain language for CNAs, precise language for the infection preventionist view.
- Always visible somewhere on screen: "Staged synthetic footage. Staff training and audit aid. Not surveillance. Not medical advice."

## Commit style
One line, present tense, gate status at the end when relevant: `add propagation engine with pathogen rules (gate 3 met)`.
