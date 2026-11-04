# See the Germs

Makes contamination chains visible on staged video of care tasks, for post-acute infection control.

It is a staff training and infection-prevention audit aid for staged or consented video. It does not diagnose, treat, or advise patients, and it gives no clinical recommendation about any person; the coaching note is workplace practice feedback for a caregiver, grounded in published hand-hygiene guidance. It is not surveillance. All footage is staged, synthetic, and contains no real patients or real facilities. It is not an image analyzer: segmentation is the sensor, and a deterministic, tested propagation engine with pathogen-specific rules, Five Moments mapping, and a counterfactual replay is the product.

Built during the Meta Global AI Developer Hackathon, Oct 26 to Nov 4, 2026.

[GIF of the glow flip goes here after the Saturday shoot.]

## The problem

Healthcare-associated infections in nursing homes spread through hands and high-touch surfaces: bed rails, call buttons, IV poles, glucometers, phones, door handles. Staff know the WHO Five Moments for Hand Hygiene and still miss moments, because contamination is invisible. Monitoring today either watches the sanitizer dispenser or relies on a human observer with a clipboard. Neither shows what actually happened to the room.

## What it does

Record a short clip of a care task in the browser, upload one, or open a staged demo clip.

1. **Scene setup by Muse Spark and SAM in a loop.** Spark vision looks at three frames and proposes the props: what each is, its zone, its role, and SAM-friendly phrases that describe appearance. SAM tests every phrase on a frame; anything it cannot find goes back to Spark for plainer phrases. The table stays editable, and anything still missing can be marked by drawing a box on a frame, which SAM tracks forward and backward through the clip as a box prompt.
2. **Tracking.** SAM 3.1 on the Meta Model API segments and tracks hands and every prop, one phrase per class, with "bare hand" and "gloved hand" as separate classes. Objects persist across the moments a hand covers them; any contact that relies on an inferred position goes to vision review. Shot changes are detected at upload, nothing is carried across one, and the upload screen says when a clip is not a single take.
3. **Contacts.** The engine turns mask overlap over time into contact events, confident or ambiguous. Muse Spark vision adjudicates only the ambiguous ones from two annotated frames: touching, passing in front, or unclear. Every vote is cached, capped per clip, and shown on the timeline with the frames it saw.
4. **Propagation.** A pure, tested engine replays the contacts with pathogen rules, hygiene events judged by agent and by WHO rub duration, glove don and doff with glove-use rules, and maps the result onto the Five Moments as opportunities met or missed.
5. **The page is the video.** "See the Germs" lights the room where the pathogen went, in sync with playback; "Heat" shows how long each surface has been contaminated. The timeline holds contacts, transfers, hygiene, gloves, and missed moments. The drawer holds the coaching note, compliance table, hygiene and glove events, score, chain graph, moments, the disinfection handoff, and the audit summary.
6. **What if.** Drag "What if hands had been cleaned at" and the chain recedes live, with before and after numbers and a two-sentence explanation on request.
7. **Narrative.** Muse Spark text writes the coaching note and the audit summary from the structured record only. It explains; it never decides.
8. **Session report.** Several clips as one session: compliance by Moment and caregiver, surfaces that keep getting contaminated, glove issues, CSV export, and a before-and-after compare for the same caregiver after coaching.

## How the Meta models are used

| Model | Endpoint | Role | Why |
| --- | --- | --- | --- |
| SAM 3.1 (`sam-3.1`) | Meta Model API, Responses API, clip uploaded once through the Files API, one call per class | Detect, segment, and track hands, persons, and surfaces across the clip | Open vocabulary from a phrase, stable object identity across frames, no training data. Used as a contact and transmission sensor, which is not what it was built for. |
| Muse Spark 1.3, vision | Meta Model API, Responses API, two annotated PNG frames, structured output | Adjudicate ambiguous contact candidates | Only sees perception edge cases the engine flagged. Verdicts are cached as engine input, capped at 12 per clip, and shown on the timeline. |
| Muse Spark 1.3, text | Meta Model API, Responses API, structured output, temperature 0 | Coaching note, audit summary, top fix, counterfactual explanation from the analysis JSON | Validated against a schema, word counts, and a disallowed-language filter; retried once; the structured panels stand on their own if it fails. |
| Muse Spark Open | Fireworks partner inference (`accounts/fireworks/models/muse-spark-open`), OpenAI-compatible chat completions, selected by `SPARK_BACKEND=fireworks` | Second backend for both Spark roles: vision adjudication and narrative, same prompts, same schemas, same validation, same caches | Open-weight path and the on-premises story. Across the feasibility clip, clip A, and clip C it agreed with the hosted model on 14 of 15 adjudications through Fireworks and 12 of 14 through Baseten (`meta-models/muse-spark-open-1026`), and wrote a valid narrative with the same top fix on each; see `npm run spark-compare`. |

The engine never calls a model. Same clip, same adjudications, same scenario, same pathogen, same output.

### Open-weight backend

Both Spark roles run end to end on Muse Spark Open through partner inference, Fireworks or Baseten. `SPARK_BACKEND=fireworks npm run dev:server` (or `SPARK_BACKEND=baseten`) serves narrative and adjudication from the open-weight model; `npm run spark-compare -- <clipId> meta fireworks` runs the same narrative and the same adjudication frames through both and writes the side by side to `data/clips/<id>/spark-compare.json`. On the demo clips the open-weight model matched the hosted model's verdicts on 14 of 15 adjudications through Fireworks (feasibility 2 of 2, A 2 of 2, C 10 of 11) and 12 of 14 through Baseten (A 3 of 3, C 9 of 11), and reached the same top fix on each; it is slower (about 10 to 30 s per call versus 5 to 10) and spends more tokens reasoning, so its output cap is floored at 6,000 tokens. The one disagreement was a gloved hand beside the resident during a squeeze, which the hosted model called passing in front and the open model called touching.

## Architecture

```
client/   React + Vite + TypeScript. Video with canvas overlay, timeline, drawer, counterfactual slider.
server/   Express + TypeScript. Upload, ffprobe and ffmpeg resampling to 10 fps, SAM calls cached per
          class, Spark vision and text behind backend interfaces, analysis, counterfactual, narrative.
engine/   Pure TypeScript, no I/O. masks, contacts, hygiene, gloves, propagation, moments, score,
          counterfactual, adjudication selection, accuracy. node:test suite.
data/     Per clip: source video, resampled video, mask tracks per class, adjudications, analysis,
          narrative, labels. Gitignored. The demo clips run offline from this cache.
```

## Engine rules in brief

- Contact: the hand mask dilated by 1.5 percent of frame width intersects an object mask above a floor for three consecutive frames at 10 fps, closing after three misses. Confident when the peak overlap is at least twice the floor and the dwell at least five frames; otherwise ambiguous and sent to adjudication. A contact that lasts half the clip is always reviewed, however thick, because a prop between the camera and the hands looks exactly like a long hold. Ambiguous candidates become contacts only with a verdict of touching or unclear.
- Propagation: the scenario names a source entity contaminated at the start. On each contact, if either side is contaminated both are, with a transfer edge when the recipient was clean. A contaminated hand touching a resident other than the source logs an exposure. Surfaces do not decay inside a clip.
- Hygiene: a dwell of at least one second at a dispenser is a hygiene event. The rub time runs from the dispenser to the next touch and must meet the WHO duration, 20 seconds for alcohol rub and 40 for soap and water, or the event is logged as too short and does not count. Whether an adequate rub cleans the hand depends on the pathogen and the agent.
- Glove rules: gloves do not replace hand hygiene. No hygiene before donning, no hygiene after doffing, one pair across two residents, and gloved contact with a healthcare-area object are each flagged.
- Compliance: every point where a Five Moments rule applied is an opportunity, met or missed. Met over opportunities per Moment, per caregiver, and across a session of clips is the figure an infection preventionist reports, with a CSV export.
- Disinfection handoff: the surfaces and resident zones contaminated at the end of the clip, ranked by contacts while contaminated, with the EPA disinfectant list the pathogen needs.
- Gloves: SAM follows an object through an appearance change, so a hand stays "bare hand" after a glove goes on and a glove is followed after it comes off. A don is therefore a new gloved-hand object appearing where a bare hand was; a doff is a new bare-hand object appearing on a gloved hand, compared hand by hand. Gloves already on at the first frame are reported as on at 0 s. A don gives a clean surface. On doff the hand gets its pre-glove state back and inherits what the glove picked up, because removal technique is not visible to the pipeline and touching the glove's outer surface contaminates the hand.
- Five Moments: Moment 1 before touching a resident, including the first approach of the clip when the caregiver had at least two seconds on camera before touching anything, Moment 2 before an aseptic task, Moment 4 after touching a resident, Moment 5 after touching the resident's surroundings and before leaving that zone. Moment 3 is out of scope. Each miss carries the entities that an inserted hygiene event at that point would have kept clean, computed by the same counterfactual rerun.
- Score: 10 per resident exposure, 3 per contaminated surface beyond the source, 2 per missed moment. A heuristic, shown as one in the UI, so the counterfactual has a before and after.

### Pathogen rules

| Pathogen | Alcohol rub clears hands | Soap and water clears hands | Source statement | Disinfectant |
| --- | --- | --- | --- | --- |
| MRSA | yes | yes | CDC: "Clean hands with soap and water or an alcohol-based hand sanitizer before and after caring for every patient." ([CDC MRSA infection control](https://www.cdc.gov/mrsa/hcp/infection-control/index.html)) | EPA List H |
| C. auris | yes | yes | CDC: "Alcohol-based hand sanitizer is preferred for C. auris when hands are not visibly soiled." ([CDC C. auris infection control](https://www.cdc.gov/candida-auris/hcp/infection-control/index.html)) | EPA List P, named on the same CDC page |
| C. difficile | no | yes | CDC: "hand sanitizer doesn't kill C. diff." ([C. diff facts for clinicians](https://www.cdc.gov/c-diff/hcp/clinical-overview/index.html)); "Washing your hands with soap and water is the best way to prevent the spread of C. diff from person to person." ([Preventing C. diff](https://www.cdc.gov/c-diff/prevention/index.html)) | EPA List K, sporicidal |
| Norovirus | no | yes | CDC: "Hand sanitizer does not work well against norovirus." ([How to prevent norovirus](https://www.cdc.gov/norovirus/prevention/index.html)) | EPA List G |

Shared sources: [CDC hand hygiene for healthcare workers](https://www.cdc.gov/clean-hands/hcp/clinical-safety/index.html) (alcohol-based hand sanitizer preferred in most clinical situations; soap and water during C. difficile and norovirus outbreaks), the [WHO Guidelines on Hand Hygiene in Health Care, 2009](https://www.who.int/publications/i/item/9789241597906) and the [WHO Hand Hygiene Technical Reference Manual, 2009](https://www.who.int/publications/i/item/9789241598606) for the Five Moments and the 20 to 30 second rub, and the [EPA selected registered disinfectant lists](https://www.epa.gov/pesticide-registration/selected-epa-registered-disinfectants) (G norovirus, H MRSA, K C. difficile spores, P C. auris). Every link was opened on Nov 4, 2026 and the quoted statement read on the page. All four pathogens persist on surfaces far longer than any clip, so there is no surface decay inside a clip. The rules table lives in `engine/pathogens.ts` and changes only with a cited source. The product never advises a patient; these rules decide only whether a staged hand-hygiene event counts in the replay.

## Measured accuracy

Contacts in each demo clip are hand-labeled with a stopwatch into `labels.json`. `npm run accuracy` compares the pipeline's contacts with the labels at a 1.0 s tolerance and lists every miss and false alarm.

| Clip | Labels | Detected | Precision | Recall | Named failures |
| --- | --- | --- | --- | --- | --- |
| feasibility (Oct 26, 24 s, bare and clear-gloved hand, rail, remote, phone) | 6 | 7 | 0.86 | 1.00 | 1 false alarm: an open palm shown above the rail after the glove came off, 1.8 s, thick overlap, which 2D cannot separate from a touch |
| A, the chain (Nov 3, 33 s, bare hands, rail, call button, phone, resident) | 4 | 4 | 1.00 | 1.00 | none; the phone stacked behind the call button went to vision review and was judged passing in front |
| B, the rub (Nov 3, 49 s, one 30 s alcohol rub) | 4 | 6 | 0.67 | 1.00 | two squeeze moments beside the resident judged as touches by vision review |
| C, gloves done right (Nov 3, 88 s, three rubs, two glove changes) | 6 | 7 | 0.86 | 1.00 | the call button registers 1.7 s before the label; glove on and off detected 4 of 4 within 1.3 s |

On the feasibility clip every real contact was found with the right hand class within 0.2 s of the stopwatch label. The clip stages two deliberate non-contacts: a 0.5 s brush of the rail while holding the remote below it, which the engine routes to vision review and which Muse Spark vision correctly called "passing in front", and an open palm held above the rail for 1.8 s, which the engine counts because the overlap is thick and long, the one false alarm in the table. The labels were written from frame sheets before looking at the engine's candidates.

To harden the pipeline before the shoot, nine public hand-hygiene and nursing skills-lab training videos were run through the live path on a local machine and checked frame by frame (none is in the demo and none is stored in the repo). That round found and fixed the glove handover failure above, added long-contact review, shot-change detection, and the first-approach Moment 1, and left the limitations below stated as measured rather than guessed. Details in `docs/ENGINE_CONTRACTS.md`.

## Limitations, stated openly

- Contact is a 2D overlap heuristic. Depth ambiguity is mitigated by staging (oblique camera, real touches), dwell, and vision adjudication of ambiguous cases, not solved. Adjudication is capped and itself fallible; every adjudicated event is marked so the user can see where the model voted.
- Glove detection depends on SAM reporting a new object when a glove goes on or comes off. Blue nitrile at close range scores well above the confidence gate; in a wide shot with small hands it falls under it and the don is missed. A removed glove held in the bare fist can read as a glove again.
- Doffing technique is not visible, so the engine assumes the bare hand is exposed on removal.
- Moment 3 (after body fluid exposure) is out of scope.
- One entity per SAM class: two hands of one person are tracked as one, and a second person's hands in frame merge into the same caregiver. A resident's or manikin's bare hands are read as bare hands. Hosted SAM caps at 16 objects per frame per class.
- A prop between the camera and the hands reads as a touch. Holds longer than half the clip are sent to vision review, shorter ones are not, so the shoot script keeps the space between camera and hands empty.
- Hygiene needs a visible dispenser or bottle. A rub with gel from a pocket is not seen. The rub time runs to the next touch, so a clip that ends mid-rub counts the rub to the end.
- Edited video is not supported. Shot changes are detected and nothing is carried across one, but a clip of one-second shots yields nothing useful.
- The exposure score weights are a heuristic, not a validated instrument.
- Muse Spark text can be stilted. It is validated for facts and language, not for style.

## Privacy stance

No real patients, no real staff, no real facilities. Every clip is staged. The badge "Staged synthetic footage. Staff training and audit aid. Not surveillance. Not medical advice." is always on screen. API keys live only on the server. The uploaded clip is resampled to 10 fps and sent to the Meta Model API for segmentation; the Meta free-credit tier states that content may be used for product improvement, which is acceptable here only because the footage is synthetic. Nothing is stored beyond the clip folder on the server, and the live upload path is capped per clip and per day.

## Run it

Requirements: Node 22.9 or newer, ffmpeg and ffprobe on the PATH (or `FFMPEG_DIR` in `.env`), a Meta Model API key.

```
npm install
cp .env.example .env        # fill in MODEL_API_KEY (only needed for uploads and new narratives)
npm test                    # engine suite, node:test
npm run build && npm start  # http://localhost:8787, the four demo clips from cache, no model call
```

For development with hot reload run `npm run dev:server` and `npm run dev:client` (http://localhost:5173, proxies /api to the server). The demo clips `feasibility`, `A`, `B`, `C` ship in the repo with their resampled video, mask tracks, verdicts, review frames, analysis, narratives in both languages, and hand labels, so everything in the demo works without a key; `npm run accuracy -- A B C` reproduces the table above.

Analyze a clip from the command line:

```
mkdir -p data/clips/myclip && cp path/to/video.mp4 data/clips/myclip/source.mp4
npm run analyze -- myclip        # probe, resample, SAM per class (cached), engine, timeline
npm run adjudicate -- myclip     # Spark vision on ambiguous candidates (cached)
npm run narrate -- myclip        # Spark text (cached by input hash)
npm run accuracy -- myclip       # needs data/clips/myclip/labels.json
```

Edit `data/clips/myclip/entities.json` to name the props, their SAM phrases, and their zones before segmenting. Deep links: `/?clip=myclip&t=8&glow=1&cf=5&agent=alcohol_rub`.

## What was built during the hackathon

Everything in this repository was written between Oct 26 and Nov 4, 2026. First commit `266d303` on 2026-10-26 at 12:49 local time. No code, prompts, components, or configs were reused from any other project. Request shapes were learned from the official Meta Model API docs and cookbook and reimplemented in TypeScript.

## Who it is for

The infection preventionist who runs the hand hygiene program, and the certified nursing assistant who gets five minutes of feedback on a staged clip of their own task. One phone camera, no sensors, no training data.

[Infection preventionist quotes go here after the Thursday and Sunday sessions.]

## License

MIT.
