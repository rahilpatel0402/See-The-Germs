# Submission text (draft, finalize Tue Nov 3)

Order follows the judging weights: impact, Meta tooling, technical depth, demo. Clinician voice first. Placeholders in brackets are filled after the Saturday shoot and the preventionist sessions.

## One-liner
Makes invisible contamination chains visible on staged video of care tasks, using SAM 3.1 to track hands and surfaces and Muse Spark to coach the caregiver, so nursing home staff can see which missed hand-hygiene moment spread the pathogen and replay the fix.

## Impact
Healthcare-associated infections in US long-term care are estimated by the CDC at one to three million serious infections a year, with hundreds of thousands of deaths. Hand hygiene is the single most effective prevention, and F880 infection control is among the most frequently cited deficiencies on nursing home surveys. Staff know the WHO Five Moments. They still miss them, because the thing they are supposed to interrupt is invisible.

I run clinical informatics across more than forty skilled nursing facilities. The tools we have today watch the sanitizer dispenser or rely on a person with a clipboard. Neither shows a certified nursing assistant that the phone she picked up after adjusting a bed rail is now carrying C. auris to the next room. See the Germs shows exactly that, on her own staged clip, in five minutes, with one phone camera and no sensor install.

Who uses it: the infection preventionist who owns the hand hygiene program, and the CNA who gets coached. The loop is staged clip, glow, one missed moment, one counterfactual, one coaching note. [Two infection preventionists tried the hosted link this week. Quote one. Quote two. The change each asked for.]

It is a staff training and infection-prevention audit aid on staged, synthetic footage. It does not diagnose, treat, or advise patients, and gives no clinical recommendation about any person. It is not surveillance.

## Use of Meta AI tooling
- SAM 3.1 on the Meta Model API is the only perception layer, used as a contact and transmission sensor, which is not what it was built for. One short noun phrase per class, one call per class per clip, clips uploaded once through the Files API, every mask track cached. "Bare hand" and "gloved hand" are separate classes, which is how glove on and glove off are detected with no manual markers.
- Muse Spark 1.3 vision adjudicates only the contact candidates the engine flags as ambiguous: two annotated frames in, one of three verdicts and one sentence out, structured output at temperature 0, cached, capped at twelve per clip. Every vote is marked on the timeline with its reasoning. SAM finds, Spark adjudicates, the engine decides.
- Muse Spark 1.3 text writes the coaching note and the audit summary from the structured record only, validated against a schema, word counts, and a clinical-language filter, and never changes the analysis.
- [If built: the same two Spark roles run end to end on Muse Spark Open through partner inference, selected by one environment variable, with outputs compared against the Meta Model API in the README.]

## Technical depth
- A pure, deterministic TypeScript engine: masks, contacts with a confident and an ambiguous band, hygiene with pathogen-specific effectiveness, glove handover, propagation as a state machine over a merged event timeline, Five Moments mapping, exposure score, counterfactual as a rerun. Seventy-eight node:test cases, including the clip A chain and the MRSA versus C. difficile rub.
- The same clip, adjudications, scenario, and pathogen always produce the same output. The counterfactual slider is instant because of it.
- Accuracy is measured, not asserted: contacts are hand-labeled with a stopwatch and `npm run accuracy` reports precision and recall at one second with every miss and false alarm named. [Table for clips A, B, C.]
- Limitations are stated in the README: 2D contact heuristic mitigated by staging, dwell, and adjudication; glove detection measured on staged footage only; Moment 3 out of scope; heuristic score weights.

## Demo
- Hosted at [URL]. Three staged demo clips run offline from cache. "Upload your own" runs the live path with a visible progress state and a 45 second cap. The live path was tested end to end on a fourth clip the pipeline had never seen.
- Repo: https://github.com/rahilpatel0402/See-The-Germs. Everything written between Oct 26 and Nov 4, 2026, first commit timestamped.
- Video: [link], three minutes, opens on the glow flip.
