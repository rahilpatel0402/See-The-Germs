# Engine module contracts

CLAUDE.md: before writing a new module, state its input and output types in one paragraph and wait for a yes. Modules are added here the evening before they are written. Everything under `engine/` is pure TypeScript, no I/O, no model calls, tested with node:test.

## masks.ts (Tue Oct 27)

Input: a `MaskRecord` as cached from SAM per frame per object: `{ frameIndex: number; objectId: string; bounds: { left, top, right, bottom } (half-open, source pixels); confidence?: number; mask: { encoding: "one_bit" | "lossless"; width; height; payload: string } }`, plus the frame size `{ w, h }`. Decoding the base85 payload to a raster is delegated to `@meta-sam/parser`'s `decodeMaskToRaster`; masks.ts wraps it.

Output: a `FrameMask` = `{ w, h, data: Uint8Array }` (row-major, 0 or 1, full frame size) and pure functions over it: `fromRecord(record, frameSize): FrameMask`, `dilate(mask, k): FrameMask` (square structuring element, k pixels), `intersectArea(a, b): number`, `area(mask): number`, `bbox(mask)`. Deterministic, allocation-explicit, no side effects. Tests use tiny hand-built 8x8 rasters, not SAM output.

Why this shape: the feasibility clip showed raw mask intersection is near zero even during a real grip because the object mask excludes the pixels the hand covers, so dilation is not optional and has to live in one tested place.

## contacts.ts (Tue Oct 27)

Input: `Tracks` = `{ frameSize: { w, h }; fps: number; entities: Entity[]; frames: Map<number, Map<entityId, FrameMask>> }` where `Entity = { id, label, class: "bare_hand" | "gloved_hand" | "object" | "resident_zone" | "dispenser"; zone: ZoneTag; samPhrase: string }`, plus `ContactConfig` from `engine/config.ts`: `{ dilationFraction: 0.015; floorPx: 150 (at 720p, scaled by frame area); openFrames: 3; closeFrames: 3; confidentIntersectionFactor: 2; confidentDwellFrames: 5 }`.

Output: `ContactCandidate[]` exactly as CLAUDE.md defines it: `{ id, handId, entityId, startT, endT, confidence: "confident" | "ambiguous", peakIntersectionPx, dwellFrames }`, sorted by startT. A candidate opens after `openFrames` consecutive hits above the floor and closes after `closeFrames` consecutive misses. Confident when peak intersection is at least `confidentIntersectionFactor` times the floor and dwell is at least `confidentDwellFrames`; otherwise ambiguous. Hand-to-dispenser overlaps are emitted as candidates too (propagation turns them into hygiene events later). Pure: same tracks and config, same output.

Why this shape: on the feasibility clip these exact rules reproduced every real touch within a second and put the 0.4 s reach-across in the ambiguous band, and the engine never needs to know masks came from SAM.

## Server modules (written Mon Oct 26 evening under the "engine plus server skeleton" approval)

- `server/ffmpeg.ts`: `probe(file): ProbeInfo` (display size after rotation, codec, fps, frames, duration) and `resample(src, dst, fps)` (constant fps, shorter side 720, H.264, faststart, no audio). Frame N of the output is at N / fps seconds.
- `server/clips.ts`: `ClipMeta` in `data/clips/<id>/meta.json`. `ensureClip(id)` probes and resamples a folder that has a `source.*` file, `createClipFromUpload(tmpPath, name)` makes a new clip id and does the same, `readMeta`, `writeMeta`, `listClipIds`.
- `server/entities.ts`: `EntityConfig` = engine `Entity` plus optional `minConfidence`. `DEFAULT_ENTITIES` for the clip A props. Stored per clip in `entities.json`, validated on write.
- `server/sam.ts`: `SegmentationBackend { name; segmentVideo(clip, phrase): SegmentationResult }` and `MetaSamBackend`. `segmentPhrase(clipId, phrase, backend)` returns the cached `TrackFile` (`tracks/<slug>.json`: records, usage, elapsed, frame size, fps) or calls the backend once and caches. One upload per clip, file id kept in meta. One log line per call with frames, objects, latency, billed frames, cost.
- `server/tracks.ts`: `loadTracks(clipId): { tracks: Tracks; entities; missingPhrases }`. Unions all records of a phrase in a frame into one entity (PLAN.md 6.1 fallback), applies `minConfidence`, and fills every sampled frame so the clip length is known.
- `server/analysis.ts`: `runAnalysis(clipId): Analysis`. Loads tracks, runs `detectContacts`, reads `adjudications.json` if present, applies the CLAUDE.md contact rule, writes `analysis.json`.
- `server/index.ts`: `GET /api/health`, `GET /api/clips`, `POST /api/clips` (multipart `video`, 45 s cap), `GET /api/clips/:id`, `PUT /api/clips/:id/entities`, `POST /api/segment { clipId }`, `POST /api/analyze { clipId }`. Keys only here.
- `server/scripts/analyze.ts`: `npm run analyze -- <clipId>`: ensure, segment missing phrases, analyze, print the timeline.

## accuracy.ts (written Mon Oct 26 evening)

Input: `LabeledContact[]` and `DetectedContact[]`, both `{ handId, entityId, startT, endT }`, plus a tolerance in seconds. Output: `AccuracyReport { precision, recall, matched, matches, misses, falseAlarms }`. A label matches a detection when hand, entity, and start agree within the tolerance; greedy one-to-one in time order. Empty inputs score 1 so a clean run is not penalized. `npm run accuracy -- <clipId>` reads `labels.json` and `analysis.json`, prints the report, and writes `accuracy.json`.

## Wednesday modules, approved and written Mon Oct 26 evening

Everything below is implemented as stated, with these decisions made while writing, flagged for Rahil:
- Chain length counts transfer edges (5 for clip A), matching the PLAN.md narrative chain. Graph hops stay in `propagation.hops` for the chain graph view, where everything one hand touches is depth 2.
- Doff rule: `DOFF_EXPOSES_BARE_HAND = true` in config.ts. On doff the bare hand gets its pre-glove state back and also inherits anything the glove picked up. Set false to restore the pre-glove state only. Clinical call, needs confirmation.
- Moment 5 fires only when the next contact is in the healthcare area, as PLAN.md 6.5 says. Patient zone A object to patient zone B object is not scored by any rule. Clinical call, needs confirmation.
- Clip A by these rules misses Moment 5 (leaving rail A) and Moment 1 (before resident B). SCHEDULE.md Gate 3 says "5, 4, 1"; Moment 4 needs a resident contact before leaving, and clip A has none before resident B. Confirm which is intended.
- Glove events carry the person's bare hand entity id as `handId` for both don and doff.
- Exposure score excludes the scenario source from the contaminated surface count, so a clean run scores 0.

## Rahil's answers, Tue Oct 27
- Doff: contamination on doff depends on removal technique, and touching the glove's outer surface contaminates the hand. Technique is not visible to the pipeline, so `DOFF_EXPOSES_BARE_HAND` stays true and the limitation says so.
- Moment 5 fires on any zone change away from patient surroundings, including patient zone A to patient zone B. Implemented.
- Gate 3 wording: his call was "best suitable". Rules stay as written (clip A flags 5 and 1); the clip A script is unchanged.

## Clinical depth, approved Tue Oct 27 evening and written

Rahil's direction: detail oriented and useful in real clinical life. Four additions, each tied to a published standard, each tested.

### hygiene.ts: duration and adequacy
`HygieneEvent` gains `durationS` (from reaching the dispenser to the person's next touch, bounded by the clip end) and `adequate` (meets `HYGIENE_CONFIG.minRubS`: 20 s alcohol rub, 40 s soap and water, from the WHO "How to Handrub" and "How to Handwash" guidance). `effective` now requires the agent to clear the pathogen and the rub to be adequate (`inadequateIsIneffective`, default true). `splitHygiene` takes the clip duration. Short rubs show as "short" on the timeline and "too short" in the drawer.

### gloverules.ts
`detectGloveIssues({ contacts, hygieneEvents, gloveEvents, entities, clipDurationS }): GloveIssue[]` with four rules from the WHO glove use leaflet and CDC hand hygiene guidance: no hygiene before donning, no hygiene after doffing, one pair across two residents, gloved contact with a healthcare-area object. Each issue carries a time and the entities involved. Shown as "!" ticks and in a Glove use section; fed to the narrative.

### moments.ts: opportunities, and compliance.ts
`detectMomentOpportunities` records every point a Moment rule applied, met or missed, with the same once-per-lapse dedup for both outcomes; `detectMoments` returns opportunities plus misses with downstream impact; `detectMomentMisses` stays as the wrapper. `complianceFrom(opportunities, personOfHand)` gives met over opportunities overall, per Moment, and per person (the WHO observation form figure). Per clip in `Analysis.compliance`; across clips via `GET /api/compliance?clips=A,B,C` (JSON) and `GET /api/compliance.csv` (one row per opportunity).

### cleaning.ts
`cleaningList(propagation, contacts, entities, scenario, profile)`: every contaminated surface and resident zone at the end of the clip, ranked by contacts while contaminated, source flagged, with the pathogen's `disinfectantNote` (EPA List H for MRSA, List P for C. auris, List K sporicidal for C. difficile, List G for norovirus; in `engine/pathogens.ts`, to be cited alongside the other rows). A "Copy list for housekeeping" button puts it on the clipboard.

`Analysis` gains `gloveIssues`, `opportunities`, `compliance`, `cleaning`; the narrative input and prompt, and the client, were updated in the same commit. Clinical facts to confirm: the four EPA list assignments and the two WHO durations.

## Polish round, Tue Oct 27 evening

- `contaminatedAt` and `recentlyContaminated` moved from the client into `engine/propagation.ts` with tests that pin them to `propagate`'s final state, since the overlay and the counterfactual glow depend on them.
- "Vision reviewed" markers on the timeline open a hover card with the two annotated frames Spark saw, the verdict, and the reasoning, served by `GET /api/clips/:id/adjudication/:candidateId/:n.png`.
- Arrow keys step one frame (ten with shift), space toggles play, outside form controls.
- Phone layout: controls wrap, selects shrink, no horizontal overflow. Verified at 600 px; headless desktop Chrome cannot go narrower than about 500 px, so the 390 px check is for a real phone.

## Second review, Tue Oct 27 evening: ten more fixes, two of them rules

For Rahil's eye:
- **Moment 4 versus 5 is now decided per zone episode.** Consecutive contacts inside one zone form an episode. Leaving a patient zone without hygiene before the next contact is one missed moment: Moment 4 if the resident was touched anywhere in that episode, otherwise Moment 5. Before, only the immediately next contact after a resident touch could be Moment 4, so resident, then blanket, then phone was wrongly labeled Moment 5. This matches WHO's wording (Moment 5 is after touching surroundings without touching the patient) and PLAN.md 6.5's "after a resident zone contact". Clip A still yields 5 then 1.
- **Moment 2 is charged once per approach**, keyed by the last non-aseptic contact, so a glucometer handling the detector split into pieces is one miss, matching how Moment 1 already worked.
- **One touch seen by both hand classes is one contact.** With a transparent glove, "bare hand" fires through the glove, so every touch after the don was counted twice (two transfers, and two resident exposures if it had landed on a resident). Overlapping contacts from the bare and gloved classes of one person on the same entity are merged, attributed to the gloved class. The feasibility clip goes from 11 contacts to 7 with the same score.

Other fixes: stale verdicts on candidates that no longer exist do not consume the adjudication cap; a stored scenario whose source was removed falls back to the default instead of failing every load; demo clips are read only and never segment live; the error handler respects already-sent headers (scrubbing the video no longer logs 500s) and maps an oversized upload to 413; a stale remote file id triggers one re-upload; the upload editor writes a default agent when a prop becomes a dispenser and never duplicates ids; finishing setup on the already-selected clip reloads it; the circular import between analysis and pipeline is gone (`server/scenario.ts`).

## Round four, approved and written Tue Oct 27: upload your own

### client/src/Upload.tsx
A panel reachable from the clip picker ("Upload your own"). Steps shown as a vertical checklist with the current one spinning: upload (multipart to `POST /api/clips`, 45 s cap and daily cap errors shown in plain words), name the props (a small table of the default entities with editable label and SAM phrase and a zone select, saved with `PUT /api/clips/:id/entities`; rows can be removed; hands and the source stay), segment (`POST /api/segment`, one line per class as it completes, with a note that this takes about a minute), review ambiguous moments (`POST /api/adjudicate`, shows how many were sent and how many came back), analyze (`POST /api/analyze`), then the clip opens in the normal page. Every step is idempotent and resumable because every server call is cached, so a refresh mid-way returns to the same step. No new server routes except one: `POST /api/segment` streams progress as newline-delimited JSON (one object per class) instead of waiting for all classes, so the UI can show lines as they land.

### server
`POST /api/segment` gains `?stream=1`: same work, responds `application/x-ndjson`, one `{ phrase, frames, objects, billedFrames, ms }` per class, then `{ done: true }`. The non-streaming form stays. Clip ids from uploads (`c_...`) are listed after the demo clips and are not narrated automatically.

## Review fixes, Tue Oct 27 afternoon

A code review over engine, server, and client found ten issues; all fixed. Two touch the rules and need Rahil's eye:
- Moment 1 is now one miss per lapse: touching the same resident twice after one unwashed arrival is one missed moment, not two. Leaving the zone and returning without hygiene is a new lapse. Previously each resident touch was charged.
- `Tracks` changed from a prebuilt map of frames to `masksAt(frameIndex)` plus `frameCount`, so the server decodes masks on demand with a 24 frame cache. The old shape held every frame of every entity as a full-frame raster at once, about a gigabyte for the 25 s feasibility clip.
Other fixes: scenario overrides are never written to analysis.json; narratives and counterfactual explanations are cached per input hash so each scenario keeps its own and nothing calls Spark twice; the 45 s cap is checked by probe before resampling and rejected uploads leave nothing on disk; a failed adjudication call is not cached as a verdict; a late counterfactual response cannot re-activate the overlay after the box is unchecked; adjudication frames are extracted at the middle of the frame interval; candidates and glove events are computed once per clip and cached until the tracks change; one `passesConfidence` helper replaces three copies and the glove default reads `GLOVE_MIN_CONFIDENCE`.

## Round three, approved and written Tue Oct 27

Written as stated. Decisions made while writing:
- `server/pipeline.ts` is the single path from cached tracks to engine outputs; analysis, counterfactual, and narrative all call it, so they can never disagree.
- Narrative cache key is a hash of the trimmed input, so changing the pathogen or source produces a new narrative and an unchanged analysis reuses the old one.
- Spark text calls need an output cap of about 8,000 tokens because reasoning tokens count against it (3,150 on the first live narrative). Recorded in docs/API_NOTES.md section 13.
- Deep link gains `cf=<seconds>&agent=` to open with the counterfactual active, for screenshots and the demo video.
- `keptClean` compares end states, so on a clip where the hand gets re-contaminated later it can be empty even when the score drops. The before and after cards carry the score difference; the overlay shows the mid-clip difference.

### Original proposal

### engine/counterfactual.ts (pure)
Input: the same `PropagationInput` the analysis used, the base `PropagationResult` and base `ExposureScore`, plus an inserted event `{ handId, t, agent: "alcohol_rub" | "soap_water" }` (effectiveness computed from the pathogen profile, so inserting an alcohol rub under C. diff correctly does nothing). Output: `Counterfactual { inserted: HygieneEvent; before: ExposureScore; after: ExposureScore; keptClean: string[] (entity ids contaminated before, clean after); propagation: PropagationResult (the rerun, for the overlay); momentMisses: MomentMiss[] (recomputed) }`. Pure rerun, instant, deterministic. Tests: clip A with a rub at 3 s under MRSA gives after score 0 and keptClean of five entities; the same under C. diff gives identical before and after.

### server: `POST /api/counterfactual { clipId, t, handId?, agent? }`
Defaults: the first hand entity of person P1 and `soap_water`. Reads the cached analysis inputs (tracks, adjudications, scenario), reruns, returns the `Counterfactual`. No model call, no cache needed.

### client: counterfactual slider
Below the timeline: a range input over the clip duration labeled "Insert hand hygiene at", an agent choice (alcohol rub or soap and water), before and after score cards, and the overlay switches to the counterfactual propagation while the slider is active so the glow recedes live. Debounced requests; the last response wins.

### server/narrate.ts and `POST /api/narrate { clipId }`
Input to Spark text: a trimmed `analysis.json` (entities with labels and zones, contacts, transfers, hygiene and glove events, moment misses with downstream labels, score, pathogen label and note, scenario). Never raw video, never masks. Prompt in `server/prompts/narrate.md` with the rules from PLAN.md 7: use only facts in the JSON, never invent contacts, never name entities outside the list, no verdict on competence, no patient-facing or clinical advice. Output schema: `{ coaching_note (120 to 180 words, second person, one concrete change), audit_summary (100 to 150 words, Five Moments by number, agent issue if any), top_fix (one sentence) }` through the same `SparkBackend.completeJson` with temperature 0. Validated: word counts within bounds, every entity label mentioned must be in the list, no disallowed phrases; on failure retry once, then the client shows structured panels only. Cached in `narrative.json` keyed by a hash of the trimmed input, so the same analysis never calls Spark twice. The counterfactual explanation is computed on request (two sentences) with the same guard, cached by inserted time.

### client: narrative panels and chain graph
Drawer gains "Coaching note" and "Audit summary" sections and the top fix sentence under the video. Chain graph: an SVG with nodes for the source, hands, objects, and residents in transfer order left to right, directed edges labeled with the time; hovering a node highlights that entity in the overlay and seeks on click. No library.

## The client (Thursday's glow), approved and written Tue Oct 27

Written as stated, with one addition: a deep link `?clip=<id>&t=<seconds>&glow=0|1` opens a clip at a moment with the toggle set, which also makes headless screenshots and the demo video reproducible.

### Original proposal

Layout rule from CLAUDE.md: the video is the page. Full width video with the timeline directly beneath it; chain graph, Five Moments, exposure score, and narrative live in a collapsible drawer. Synthetic footage badge always visible. No component library, one small CSS file.

### Server routes the client needs
- `GET /api/clips/:id/video`: streams `sampled.mp4` with range support (the frames the masks were computed on, so overlay and video agree).
- `GET /api/clips/:id/analysis`: `analysis.json`, 404 until analyzed.
- `GET /api/clips/:id/tracks`: `{ frameSize, fps, entities: [{ id, label, class, zone }], tracks: Record<entityId, MaskRecord[]> }` with the entity's `minConfidence` already applied. Raw base85 payloads; the client decodes. Feasibility clip: under 1 MB.
- `GET /api/demo`: the list of precomputed demo clip ids (Sunday).

### client/ (Vite + React + TypeScript)
- `client/src/api.ts`: typed fetchers for the routes above. Input: clip id. Output: the engine types imported from `engine/types.ts` by relative path (types only, no engine code in the bundle except what the overlay imports from `engine/masks.ts`, which is pure).
- `client/src/overlay.ts` (pure, no React): `buildOverlayIndex(tracks): OverlayIndex` maps frame index to `{ entityId, path: Path2D, bounds }[]`, decoding each record once with `@meta-sam/parser`'s SVG path and caching. `contaminationAt(analysis, t): Set<entityId>` replays `propagation.changes` up to time t. `drawFrame(ctx, index, frameIndex, contaminated, options)`: clean entities get a faint outline, contaminated ones a glowing fill; a transfer within the last 400 ms pulses. Same inputs, same pixels.
- `client/src/VideoStage.tsx`: `<video>` plus a `<canvas>` sized to the video's rendered box, `requestAnimationFrame` loop reading `video.currentTime`, frame index = `Math.floor(t * fps)`. The "See the Germs" toggle switches the overlay between outlines only and the glow. Props: clip id, analysis, overlay index, toggle state, hover highlight.
- `client/src/Timeline.tsx`: a strip under the video with one lane per kind: contacts (confident solid, adjudicated with a small "vision reviewed" marker whose hover shows verdict and reasoning), transfers, hygiene (effective or ineffective), glove don and doff, moment misses. Click or drag seeks the video. Props: analysis, duration, currentTime, onSeek.
- `client/src/Drawer.tsx`: collapsible side panel with three sections for now: chain (a simple list of transfer edges in order, graph on Friday), Five Moments (misses with time and downstream), exposure score (the four numbers and the heuristic weights). Narrative panel arrives Sunday.
- `client/src/App.tsx`: clip picker (list from `GET /api/clips`), scenario controls (pathogen select, source select, posting to `/api/analyze` with overrides), the stage, the timeline, the drawer, and the badge text "Staged synthetic footage. Staff training and audit aid. Not surveillance. Not medical advice."
- `client/src/styles.css`: one file. Dark stage, glow in a warm color that reads as a hazard without reading as blood.
- Scripts: `npm run dev:client` (vite in `client/`), `npm run build:client`. Vite proxies `/api` to the server in dev.

Gate 4 check: on the dev clip, hitting the toggle makes the room light up in sync with the video, and scrubbing the timeline moves the video.

## Vision adjudication, approved Tue Oct 27 and written

### engine/adjudication.ts (pure)
Input: `ContactCandidate[]`, existing `Adjudication[]`, `AdjudicationConfig { capPerClip: 12 }`. Output: `AdjudicationPlan { selected: ContactCandidate[]; skipped: ContactCandidate[]; frames: Record<candidateId, { first: number; middle: number }> }`. Only ambiguous candidates without a cached verdict are eligible. If more than the cap, the lowest peak intersection ones are selected first and the rest are skipped and kept as contacts (PLAN.md 6.8). Frames are the first and the middle frame of the candidate window. Deterministic order. Tests on synthetic candidates.

### server/spark.ts
`SparkBackend { name; completeJson(req: { instructions: string; text: string; images: Buffer[] (PNG); schema: object; schemaName: string; maxOutputTokens: number }): Promise<{ json: unknown; usage: { inputTokens, outputTokens, reasoningTokens, cachedTokens }; elapsedMs }> }`. `MetaSparkBackend` uses `muse-spark-1.3` on the Responses API with `input_image` data URLs, `text.format` json_schema strict, temperature 0, reasoning effort low, `store: false` (the shape verified in docs/API_NOTES.md section 5). Baseten adapter later builds a chat completion from the same request. One log line per call with tokens and cost.

### server/frames.ts
`renderAnnotatedFrame(clipId, frameIndex, outlines: { entityId; mask: FrameMask; color }[]): Promise<Buffer>`: extracts the sampled frame at `frameIndex / fps` with ffmpeg, traces each mask to an SVG path with the parser's `decodeMaskToSVGPath` offset by its bounds, and composites the stroked paths onto the frame with `sharp`. Hand outline cyan, object outline magenta, nothing else drawn. New dependency: `sharp` (prebuilt binary, no Python).

### server/adjudicate.ts and the route
`adjudicateClip(clipId, backend)`: load tracks, detect candidates, build the plan, and for each selected candidate render the two frames, send them with the object label and the prompt in `server/prompts/adjudicate.md`, validate the verdict against `{ verdict: touching | passing_in_front | unclear; reasoning: string }`, and append to `adjudications.json`. Cached verdicts are never re-asked. Then `runAnalysis` consumes them. `POST /api/adjudicate { clipId }` and `npm run adjudicate -- <clipId>`. The prompt asks one perception question and never mentions pathogens, hygiene, or zones.

### Original proposal

Two small additions to `Entity` first, both optional so existing clips keep working:
- `person?: string` (default `"P1"`). The bare hand and gloved hand classes of the same person are the same physical hands. Contacts from either class apply to the hand state of that person. Hand state is keyed by person, not by SAM class.
- `agent?: "alcohol_rub" | "soap_water" | "gloves"` on dispenser entities. Says what a dwell at that dispenser produces.

### pathogens.ts
Input: none; it is a table. Output: `PATHOGENS: Record<PathogenId, PathogenProfile>` with `PathogenId = "mrsa" | "c_auris" | "c_difficile" | "norovirus"` and `PathogenProfile { id, label, alcoholRubClearsHands: boolean, soapWaterClearsHands: boolean, surfacePersistenceS: number (effectively infinite within a clip), uiNote: string, citations: string[] }`. Values exactly as PLAN.md 6.3. Citations to CDC and WHO pages are filled in by Rahil, not invented.

### hygiene.ts
Input: `ContactEvent[]`, entities, `HygieneConfig { minDwellS: 1.0 }`, a `PathogenProfile`. Output: `{ hygieneEvents: HygieneEvent[], gloveDispenserTouches: { handId, t }[], contacts: ContactEvent[] without dispenser contacts }`. A contact with a dispenser whose dwell is at least `minDwellS` becomes a `HygieneEvent { handId, t: startT, agent, effective }` where `effective` comes from the pathogen profile for that agent. Dispenser contacts never count as contamination transfer.

### gloves.ts
Input: `Tracks` (hand entities only matter), `GloveConfig { openFrames: 3, closeFrames: 3, handoverWindowFrames: 10, maxHandoverDistanceFraction: 0.15 of frame width }`. Output: `GloveEvent[]` with `source: "detected"`. A don at frame f: the gloved class of person P becomes present for `openFrames` consecutive frames, and within the previous `handoverWindowFrames` the bare class of P was present with a bounding box center within the distance limit. A doff: the gloved class of P is absent for `closeFrames` frames after being present, and the bare class is present nearby within the window. `t` is the first gloved frame (don) or the first absent frame (doff). The fallback (glove box dwell for don, manual marker for doff) is a separate path behind a config flag and is only used if nitrile separation fails tomorrow.

### propagation.ts
Input: `{ contacts: ContactEvent[] (dispensers removed), hygieneEvents, gloveEvents, entities, scenario: { sourceEntityId, pathogen: PathogenId }, profile }`. All events are merged into one list sorted by time, ties broken by a fixed order (glove, hygiene, contact) then by ids, so the result is deterministic. Output: `PropagationResult { contaminated: Set<entityId> at end, transfers: TransferEdge[], residentExposures: { residentId, handId, t }[], changes: { t, entityId, contaminated: boolean, cause: "source" | "transfer" | "hygiene" | "glove_don" | "glove_doff" }[] }`. Rules exactly as PLAN.md 6.4: on a contact, if either side is contaminated both are, with a transfer edge only if the recipient was clean; a hygiene event cleans the hand only if effective for the pathogen, otherwise it is logged ineffective; a don sets the hand state clean and remembers the pre-glove state; a doff restores the pre-glove state; a contaminated hand touching a resident zone logs an exposure. Surfaces never decay inside a clip.

### moments.ts
Input: the same contacts, effective hygiene events, glove events, entities with zones, plus a function to rerun propagation with an inserted hygiene event (passed in, so moments.ts stays pure). Output: `MomentMiss[]` per PLAN.md 6.5: Moment 1 before a resident zone contact with no effective hygiene since the last contact outside that patient zone; Moment 2 before an entity tagged aseptic (scenario B glucometer) with no hygiene before it; Moment 4 after a resident zone contact when the hand next touches the healthcare area or another patient zone without hygiene; Moment 5 after patient zone objects when the hand leaves to the healthcare area without hygiene. `downstream` is the set of entities that stay clean when a hygiene event is inserted at that moment, computed with the rerun function.

### score.ts
Input: `PropagationResult`, `MomentMiss[]`, entities. Output: `ExposureScore { contaminatedSurfaces, chainLength (max hops from source over transfer edges), residentExposures: Record<residentId, number>, momentsMissed: Record<1|2|4|5, number>, score: 10 * exposures + 3 * surfaces + 2 * misses }`. Weights live in config.ts and are shown in the UI as a heuristic.

### Analysis shape after Wednesday
`Analysis` gains `scenario`, `pathogen`, `hygieneEvents`, `gloveEvents`, `propagation`, `momentMisses`, `score`. Once the client and the Spark prompt read it, it changes only with both in the same commit.
