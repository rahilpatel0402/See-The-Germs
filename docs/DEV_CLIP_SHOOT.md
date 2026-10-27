# Dev clip shot list (Tue Oct 27)

A rough solo version of clip A from PLAN.md section 8, plus one glove don and one pass-in-front. This is the clip the pipeline is developed against until the Saturday shoot. Ten minutes. Props do not need to look clinical; they need plain names.

## Lessons from the feasibility clip (Oct 26)
- Camera about 45 degrees from the side, not straight overhead. From above, a hover and a touch look the same.
- Landscape. Phone propped against something solid, main lens, 1080p, 30 fps, no zoom, no portrait mode.
- Bright, even light. Plain background. Everything in frame for the whole clip, including both hands.
- Unwrapped props with simple appearance: SAM found "white rod" and "plastic wrapped remote" but not "towel rail" or "remote control".
- Blue or purple nitrile gloves.

## Props and their SAM phrases (first guess, tune on one frame before the clip run)
| Role in the scenario | Prop | Phrase to try first |
| --- | --- | --- |
| Bed rail A (source) | the white curtain rod | white rod |
| IV pole | a lamp, coat rack, or broom standing up | floor lamp / broom |
| Phone (healthcare area) | the spare phone | phone |
| Blanket B | a folded towel or blanket on a chair | blanket / towel |
| Resident B | a pillow under the blanket with a sheet of paper labeled B, or a second person | pillow / person |
| Sanitizer dispenser | a pump bottle | pump bottle |
| Glove box | a tissue box | tissue box |

Write down what you used. The server config will carry the phrase and the label separately.

## The script, about 30 to 40 seconds
1. Bare hand: grip rail A, hold one second. (Source contact.)
2. Bare hand: grip the IV pole, hold one second.
3. Bare hand: pick up the phone, hold one second, put it down.
4. Reach into the tissue box and put the glove on (one hand is enough). Don on camera.
5. Gloved hand: touch blanket B, hold one second.
6. Gloved hand: touch resident B (the pillow), hold one second.
7. Bare hand: one slow pass across the front of rail A, a few inches away, no contact.
8. Hands out of frame. Stop.

No hand hygiene in this clip. That is the point of clip A.

## After shooting
- Save to `data/clips/dev/source.mp4` (any phone format is fine; the folder is gitignored).
- While it is fresh, write the real contacts with a stopwatch into `data/clips/dev/labels.json`:

```json
{
  "clipId": "dev",
  "contacts": [
    { "hand": "bare", "entity": "rail_A", "startT": 1.2, "endT": 2.4 },
    { "hand": "bare", "entity": "iv_pole", "startT": 4.0, "endT": 5.1 }
  ],
  "gloveEvents": [{ "type": "don", "t": 12.5 }],
  "nonContacts": [{ "hand": "bare", "entity": "rail_A", "startT": 30.0, "endT": 31.5, "note": "pass in front" }]
}
```

Times to the nearest half second are fine. `npm run accuracy` compares with a 1.0 s tolerance.
