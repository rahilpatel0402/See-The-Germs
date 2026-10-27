# Saturday shoot script (Sat Oct 31)

Three clips, A, B, C, several takes each. One helper. Review every take on the laptop before moving on. Reshoot anything where a hand leaves frame or an object is hidden. Then a fourth short clip, any task, never shown, for the live upload test on Sunday.

## Set
- Camera: phone on a tripod or a stack of books, landscape, main lens, 1080p 30 fps, about 45 degrees from the side and slightly above the table. Never straight overhead: from above a hover and a touch look identical. From the side the gap and the shadow show.
- Light: bright and even, no backlight. Plain wall or sheet behind the set if possible.
- Tape the prop positions on the floor or table so every take and every clip uses the same layout. Keep every object in frame for the whole clip, including both hands, including during the walk to resident B.
- Hands: sleeves pushed up, nothing on the wrists that could read as a glove edge. Blue or purple nitrile gloves for contrast.
- Movements slow and deliberate. Real touches held for about one second. One action at a time.

## Props and the phrases SAM will be asked for
Phrases describe appearance, not function (feasibility clip: "towel rail" found nothing, "white rod" tracked perfectly). Test each phrase on one still frame before the clip run.

| Scenario role | Prop | Suggested phrase | Zone |
| --- | --- | --- | --- |
| Bed rail A (the source) | white curtain rod or broom handle on two books | white rod | patient zone A |
| Resident A | pillow under a blanket on a chair or bed, paper label "A" | pillow | patient zone A |
| IV pole | floor lamp or coat rack | floor lamp | healthcare area |
| Call button | unwrapped TV remote | black remote control | patient zone A |
| Phone | the spare phone, face down | phone | healthcare area |
| Glucometer (clip B) | small white box | white box | healthcare area, aseptic |
| Sanitizer dispenser | pump bottle | pump bottle | hygiene station |
| Glove box | tissue box | tissue box | hygiene station |
| Blanket B | folded towel or blanket on a second chair | blanket | patient zone B |
| Resident B | second pillow under blanket B, paper label "B", or the helper | pillow | patient zone B |

If two props share a phrase ("pillow"), SAM returns two tracks under one phrase and they become one entity. Make them visually different (one white pillow, one colored cushion) and use two phrases.

## Clip A: the chain (30 to 40 s)
Pathogen MRSA. Source rail A. No hygiene at all. Proves transitive spread to a second resident.
1. Enter frame. Grip rail A, hold one second.
2. Adjust the IV pole, hold one second.
3. Pick up the phone, hold one second, put it down.
4. Walk to resident B. Touch blanket B, hold one second.
5. Touch resident B (the pillow), hold one second.
6. Hands out of frame. Stop.
Expected: chain rail A to hand to IV pole to phone to blanket B to resident B. Moment 5 at the rail, Moment 1 at resident B. Score 23.

## Clip B: wrong agent (30 to 40 s)
Pathogen C. difficile in the UI. Source rail A. Hygiene happens and does not help.
1. Grip rail A, hold one second.
2. Walk to the pump bottle. Press it and rub hands for a full two seconds, hands near the bottle the whole time (the dwell is what the engine sees).
3. Pick up the glucometer box, hold one second, put it down.
4. Touch resident B, hold one second.
5. Hands out of frame. Stop.
Expected under C. diff: the rub is logged ineffective, Moment 2 before the glucometer and Moment 1 before resident B are missed, resident B exposed. Toggle to MRSA: the same clip goes clean after the rub. The clinical nuance.

## Clip C: clean run (35 to 45 s)
Pathogen MRSA. Source rail A. Nothing lights up except the source. Also exercises glove detection and adjudication on the final footage.
1. Grip rail A, hold one second.
2. Pump bottle, rub for two seconds.
3. Reach into the tissue box and put a glove on one hand, on camera, slowly.
4. One deliberate pass of the bare hand in front of rail A, between camera and rail, a few inches away, no contact.
5. Gloved hand: touch blanket B, then resident B, one second each.
6. Pull the glove off, on camera, slowly, and drop it out of frame.
7. Pump bottle again, rub for two seconds.
8. Hands out of frame. Stop.
Expected: glove don and doff detected, the pass in front flagged ambiguous and adjudicated passing in front, only rail A glowing at the end. Score 0.

## Fourth clip (live path test, never shown)
Any 20 to 30 s task with three or four of the same props. Used only on Sunday to prove the hosted upload path works on a clip the pipeline has never seen.

## Right after shooting, while it is fresh
- Save as `data/clips/A/source.mp4`, `data/clips/B/source.mp4`, `data/clips/C/source.mp4`, `data/clips/live_test/source.mp4`.
- Stopwatch every real contact into `labels.json` per clip (format in DEV_CLIP_SHOOT.md). Note the glove on and off times and the pass in front as a non-contact.
- Write `entities.json` per clip from the table above, with `agent` on the two dispensers, `aseptic: true` on the glucometer, `person: "P1"` on both hands.
- Run `npm run analyze -- A` and `npm run accuracy -- A` for each clip. Recall under 0.8 on any clip means tune or reshoot before the set is struck.
