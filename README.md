# See the Germs

Makes contamination chains visible on staged video of care tasks, for post-acute infection control.

It is a staff training and infection-prevention audit aid for staged or consented video. It does not diagnose, treat, or advise patients, and it gives no clinical recommendation about any person; the coaching note is workplace practice feedback for a caregiver, grounded in published hand-hygiene guidance. It is not surveillance. All footage is staged, synthetic, and contains no real patients or real facilities. It is not an image analyzer: segmentation is the sensor, and a deterministic, tested propagation engine with pathogen-specific rules, Five Moments mapping, and a counterfactual replay is the product.

Built during the Meta Global AI Developer Hackathon, Oct 26 to Nov 4, 2026.

[GIF of the glow flip goes here after the Saturday shoot.]

## The problem

Healthcare-associated infections in nursing homes spread through hands and high-touch surfaces: bed rails, call buttons, IV poles, glucometers, phones, door handles. Staff know the WHO Five Moments for Hand Hygiene and still miss moments, because contamination is invisible. Monitoring today either watches the sanitizer dispenser or relies on a human observer with a clipboard. Neither shows what actually happened to the room.

## What it does

Upload a short clip of a care task, or open one of the staged demo clips.

1. SAM 3.1 on the Meta Model API detects, segments, and tracks hands and every touchable surface, one short noun phrase per class, with "bare hand" and "gloved hand" as separate classes.
2. The engine turns mask overlap over time into contact events, with a confident band and an ambiguous band.
3. Muse Spark vision adjudicates only the ambiguous candidates from two annotated frames: touching, passing in front, or unclear. Every vote is cached, capped per clip, and marked on the timeline.
4. A pure propagation engine replays the contacts with pathogen rules (what alcohol rub does and does not clear), glove don and doff, and hygiene events, and maps the result onto the Five Moments.
5. The page is the video. Flip "See the Germs" and the room lights up where the pathogen went, in sync with playback. The timeline underneath holds contacts, transfers, hygiene, gloves, and missed moments. A drawer holds the chain graph, the moments, the score, and the narrative.
6. Drag "What if hands had been cleaned at" and the chain recedes live, with before and after numbers.
7. Muse Spark text writes a coaching note for the caregiver and an audit summary for the infection preventionist from the structured record only. It explains; it never decides.

## How the Meta models are used

| Model | Endpoint | Role | Why |
| --- | --- | --- | --- |
| SAM 3.1 (`sam-3.1`) | Meta Model API, Responses API, clip uploaded once through the Files API, one call per class | Detect, segment, and track hands, persons, and surfaces across the clip | Open vocabulary from a phrase, stable object identity across frames, no training data. Used as a contact and transmission sensor, which is not what it was built for. |
| Muse Spark 1.3, vision | Meta Model API, Responses API, two annotated PNG frames, structured output | Adjudicate ambiguous contact candidates | Only sees perception edge cases the engine flagged. Verdicts are cached as engine input, capped at 12 per clip, and shown on the timeline. |
| Muse Spark 1.3, text | Meta Model API, Responses API, structured output, temperature 0 | Coaching note, audit summary, top fix, counterfactual explanation from the analysis JSON | Validated against a schema, word counts, and a disallowed-language filter; retried once; the structured panels stand on their own if it fails. |
| Muse Spark Open | Planned after the core is complete, through a partner inference API behind the same backend interface | Second backend for both Spark roles | Open-weight path and the on-premises story. Not built yet. |

The engine never calls a model. Same clip, same adjudications, same scenario, same pathogen, same output.

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

- Contact: the hand mask dilated by 1.5 percent of frame width intersects an object mask above a floor for three consecutive frames at 10 fps, closing after three misses. Confident when the peak overlap is at least twice the floor and the dwell at least five frames; otherwise ambiguous and sent to adjudication. Ambiguous candidates become contacts only with a verdict of touching or unclear.
- Propagation: the scenario names a source entity contaminated at the start. On each contact, if either side is contaminated both are, with a transfer edge when the recipient was clean. A contaminated hand touching a resident zone logs an exposure. Surfaces do not decay inside a clip.
- Hygiene: a dwell of at least one second at a dispenser is a hygiene event. The rub time runs from the dispenser to the next touch and must meet the WHO duration, 20 seconds for alcohol rub and 40 for soap and water, or the event is logged as too short and does not count. Whether an adequate rub cleans the hand depends on the pathogen and the agent.
- Glove rules: gloves do not replace hand hygiene. No hygiene before donning, no hygiene after doffing, one pair across two residents, and gloved contact with a healthcare-area object are each flagged.
- Compliance: every point where a Five Moments rule applied is an opportunity, met or missed. Met over opportunities per Moment, per caregiver, and across a session of clips is the figure an infection preventionist reports, with a CSV export.
- Disinfection handoff: the surfaces and resident zones contaminated at the end of the clip, ranked by contacts while contaminated, with the EPA disinfectant list the pathogen needs.
- Gloves: a don is the gloved-hand track appearing where the bare-hand track just was; a doff is the reverse. A don gives a clean surface. On doff the hand gets its pre-glove state back and inherits what the glove picked up, because removal technique is not visible to the pipeline and touching the glove's outer surface contaminates the hand.
- Five Moments: Moment 1 before touching a resident, Moment 2 before an aseptic task, Moment 4 after touching a resident, Moment 5 after touching the resident's surroundings and before leaving that zone. Moment 3 is out of scope. Each miss carries the entities that an inserted hygiene event at that point would have kept clean, computed by the same counterfactual rerun.
- Score: 10 per resident exposure, 3 per contaminated surface beyond the source, 2 per missed moment. A heuristic, shown as one in the UI, so the counterfactual has a before and after.

### Pathogen rules

| Pathogen | Alcohol rub clears hands | Soap and water clears hands | Note shown in the UI |
| --- | --- | --- | --- |
| MRSA | yes | yes | Alcohol rub is effective. |
| C. auris | yes | yes | Persists on surfaces for weeks; alcohol rub effective; a major NY nursing home concern. |
| C. difficile | no | yes | Spores are not killed by alcohol rub. Soap and water required. Contact precautions. |
| Norovirus | no | yes | Alcohol rub is largely ineffective. Soap and water required. |

All four persist on surfaces far longer than any clip, so there is no surface decay inside a clip. CDC and WHO citations for each row are being added by the author; the rules table lives in `engine/pathogens.ts` and changes only with a cited source.

## Measured accuracy

Contacts in each demo clip are hand-labeled with a stopwatch into `labels.json`. `npm run accuracy` compares the pipeline's contacts with the labels at a 1.0 s tolerance and lists every miss and false alarm.

| Clip | Labels | Detected | Precision | Recall | Named failures |
| --- | --- | --- | --- | --- | --- |
| A, B, C | to be measured after the Oct 31 shoot | | | | |

On the Oct 26 feasibility clip (24 s, bare and clear-gloved hand, rail, remote, phone), every real contact was found with the right hand class within a second; the one false positive was a deliberate pass over the rail, which the 2D heuristic cannot distinguish from a touch and which Muse Spark vision correctly called "passing in front" from the two annotated frames. Details in `docs/API_NOTES.md`.

## Limitations, stated openly

- Contact is a 2D overlap heuristic. Depth ambiguity is mitigated by staging (oblique camera, real touches), dwell, and vision adjudication of ambiguous cases, not solved. Adjudication is capped and itself fallible; every adjudicated event is marked so the user can see where the model voted.
- Glove detection depends on SAM separating gloved and bare hands. With a transparent glove the bare class also fires through the glove; a confidence threshold handles it. Measured on staged footage only.
- Doffing technique is not visible, so the engine assumes the bare hand is exposed on removal.
- Moment 3 (after body fluid exposure) is out of scope.
- One entity per SAM class: two hands of one person are tracked as one. Hosted SAM caps at 16 objects per frame per class.
- The exposure score weights are a heuristic, not a validated instrument.
- Muse Spark text can be stilted. It is validated for facts and language, not for style.

## Privacy stance

No real patients, no real staff, no real facilities. Every clip is staged. The badge "Staged synthetic footage. Staff training and audit aid. Not surveillance. Not medical advice." is always on screen. API keys live only on the server. The uploaded clip is resampled to 10 fps and sent to the Meta Model API for segmentation; the Meta free-credit tier states that content may be used for product improvement, which is acceptable here only because the footage is synthetic. Nothing is stored beyond the clip folder on the server, and the live upload path is capped per clip and per day.

## Run it

Requirements: Node 22.9 or newer, ffmpeg and ffprobe on the PATH (or `FFMPEG_DIR` in `.env`), a Meta Model API key.

```
npm install
cp .env.example .env        # fill in MODEL_API_KEY
npm test                    # engine suite, node:test
npm run dev:server          # http://localhost:8787
npm run dev:client          # http://localhost:5173, proxies /api to the server
```

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
