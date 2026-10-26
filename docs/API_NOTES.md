# API notes: Meta Model API, SAM 3.1 video and Muse Spark

Written Mon Oct 26, 2026 (Gate 1) from the official docs at dev.meta.ai, the `@meta-sam/parser` 0.1.0 package, and the `meta-models/meta-sam` protocol spec. The only live call so far is `GET /v1/models` (section 1). Section 9 lists what the feasibility clip must verify tonight.

Sources: dev.meta.ai/docs/sam/overview, /docs/sam/segmenting, /docs/sam/reading-segmentation, /docs/sam/client-libraries, /docs/protocols/responses, /docs/protocols/chat-completions, /docs/image-understanding, /docs/structured-output, /docs/file-handling, /docs/pricing-rate-limits, /docs/error-handling, /docs/api-reference/responses/schemas, /docs/models, /docs/muse-spark-open/deploy, github.com/meta-models/meta-sam (protocol/sam3.md), github.com/meta-models/meta-model-cookbook (07_sam/01_api_basics, read for shape only, Python and TypeScript examples never copied), npm @meta-sam/parser 0.1.0.

## 1. Common

- Base URL: `https://api.meta.ai/v1`
- Auth: `Authorization: Bearer <key>` on every call. The key is `MODEL_API_KEY` in `.env`, matching the docs, the cookbook, and CLAUDE.md (renamed from `META_MODEL_API_KEY` on Oct 26).
- Verified Oct 26 with `GET /v1/models`, HTTP 200. Enabled on this account: `sam-3.1`, `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.1`, `muse-wonder-1.0`, `muse-image-1.0`, `muse-voice-transcribe-1.0`.
- OpenAI compatible. Per CLAUDE.md the server calls through the `openai` npm package with `baseURL` set, using the Responses API for both SAM and Spark. Raw `fetch` with server-sent events also works and is the fallback if the SDK fights the SAM event stream.
- Rate limits are per team: `sam-3.1` 3,000 requests per minute, no token limit; `muse-spark-1.1` and `1.3` 3,000 requests per minute, 4,000,000 tokens per minute. Nothing in this project gets near either.
- Errors: 400 is a bad request, fix and resend, never retry unchanged. 429 carries `Retry-After`; back off 0.5 to 1 s doubling with jitter, 3 to 5 tries. 504 means the request took too long; use streaming or shorten input, do not just retry.
- Files API: `POST /v1/files`, multipart, `purpose=user_data`, `file` last. Up to 1 GiB per file. Video accepted as `video/mp4` only. Files do not expire by default; optional `expires_after[anchor]=created_at` and `expires_after[seconds]` (3600 to 2592000). 100 GiB per team. `DELETE /v1/files/{file_id}` to clean up. Inline media (base64 data URL or public URL) is capped at 50 MB.

## 2. SAM 3.1 video: request

Model id `sam-3.1`. Responses API only: `POST /v1/responses`. One user message with one `input_text` part (the prompt) and one `input_video` part.

How the video is sent, three options:
1. `input_video.file_id` from a prior Files API upload. Recommended. Upload once per clip, reuse the id for every class call (eleven calls per clip).
2. `input_video.video_url` as a public https URL.
3. `input_video.video_url` as a base64 `data:` URL, under 50 MB.

`input_video` also has an `fps` field (number, nullable) in the Responses schema. It is not documented on the SAM pages. Unknown whether SAM honors it. We will not depend on it; see section 8.

How the text prompt is sent: `input_text.text` is one short noun phrase naming one concept. One concept per request. Comma or semicolon lists return zero matches; "and" segments only one concept. No commands, no questions, no negation, no spatial phrasing. Attributes narrow matches ("gloved hand", "blue nitrile glove"). Zero matches is a normal completed response with empty output, not an error.

Request metadata (all values are strings):
- `mask_encoding`: `"lossless"` (default, `~` marker) or `"one_bit"` (`!` marker, smaller and faster). Box or point prompts always return `one_bit`.
- `include_confidence`: `"true"` adds `c` (0 to 1) to every box and mask record, per object per frame.
- `propagation_direction`: `"both"` (default: earliest prompt frame to end, then back to frame 0), `"forward"`, or `"backward"`. Only meaningful for box or point prompts; for a text prompt the whole clip is processed.

Streaming: `stream: true` is recommended for video. Non-streaming returns the same output in one response. Events that matter: `response.output_text.delta` (one video frame per delta), `response.content_part.done` (finalizes the text lane; live SAM emits this, not `response.output_text.done`), `response.completed`. Results can vary slightly between runs, so cache the first good run and never re-call.

Example request body, text prompt on an uploaded clip:

```json
{
  "model": "sam-3.1",
  "stream": true,
  "metadata": { "mask_encoding": "one_bit", "include_confidence": "true" },
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "gloved hand" },
        { "type": "input_video", "file_id": "file-abc123" }
      ]
    }
  ]
}
```

Accepted containers and codecs: MP4 or MOV container, H.264, H.265, or MPEG-4 video. VP9 and WebM are rejected. The Files API lists `video/mp4` only, so iPhone MOV must be remuxed to MP4 before upload. The service remuxes MP4s without faststart losslessly; we will export with `-movflags +faststart` anyway.

Limits: up to 15,000 frames per request (about 10 minutes). Video tracks up to 16 objects per frame per request. Box or point prompts may name up to 16 objects. 400 on more than 16 objects, mixed prompt types, duplicate ids, `w`/`h` not matching the media, points outside the frame, or invalid metadata values.

## 3. SAM 3.1 video: response and mask encoding

Output is not JSON. It arrives as special-token text in the `output_text` lane, one line per frame:

```
<Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=W;h=H[;c=0.9]|><|mask;x=0;y=0;[c=0.9;]data=h,w,~payload|>,id<|box;...|><|mask;...|>
```

Frame indexing:
- `<Nf>` is the zero-based frame index of the video as the API processed it. Frames with no visible object emit no line, so indices skip. Never assume line number equals frame number; read `N`.
- With `propagation_direction: both`, forward frames arrive first, then backward frames, so lines can be out of order. Sort by frame index after parsing.
- The docs do not state whether `N` counts source frames or resampled frames, and give no fps. We resolve this by construction: ffmpeg resamples every clip to a constant 10 fps before upload, so frame `N` is at `t = N / 10` seconds. Verified Oct 26 on a 5.9 s sample: ffprobe counted 59 frames after resampling and `usage.video_frames_processed` was 59 on both class calls, with frame indices 0 to 58.

Object identity:
- The leading integer is a stable per-object id within one response. Ids are sparse, not dense, not 0-based (a line can carry `0, 2`). Key everything by id.
- Ids hold while the object stays in frame. Do not trust them across exit and re-entry or long full occlusion. The docs do not say whether ids are reused after an object leaves. Per-class calls keep this manageable: a "bare hand" call returns at most two tracks of interest.
- With box or point prompts, you choose the ids and the response uses them.

Box: `x1,y1` top left, `x2,y2` bottom right, inclusive, in source pixels. `w,h` are the frame size, repeated on every record. The parser normalizes to half-open `left, top, right = x2 + 1, bottom = y2 + 1`.

Mask: `data=h,w,<enc>payload`. `h` then `w` are the raster's own dimensions, not the frame's. The raster covers the record's box: the parser attaches `bounds` (the half-open box) to each mask record so a renderer knows where the `h x w` raster sits in the `w x h` frame. `x=0;y=0` are always literal zeros. Payload is base85 (alphabet `!` through `{` minus the delimiters `" \ , ; < > |`), a five-character length prefix, then an arithmetic-coded body packed four bytes to five characters. The coder internals are not documented; decode with the official parser, do not hand-roll.

Decoding in TypeScript: `@meta-sam/parser` 0.1.0 (npm), ESM only, zero runtime dependencies, Node `^20.17.0 || >=22.9.0` (we are on Node 24.18). SAM License, not MIT; it is a dependency, not copied code. Functions:
- `parseVideoStream(events)` takes any `AsyncIterable` of objects with a string `type`, including the OpenAI SDK's Responses stream directly. Returns an async iterable of cumulative snapshots plus `finalResult`.
- `result.records` is one ordered list of `box` and `mask` records. `recordsOfKind(records, 'mask')` filters. `frameIndexOf(record)` gives the frame.
- `SegmentationMaskRecord`: `objectId: string`, `frame: { frameIndex }`, `mask: { encoding, width, height, payload }`, `bounds: { left, top, right, bottom }`, `confidence?`.
- `decodeMaskToRaster(mask)` returns a row-major `Uint8Array` of `width * height` entries, each 0 or 1.
- `decodeMaskToRLE(mask)` returns COCO compressed RLE `{ size: [height, width], counts }` (column-major, as COCO expects).
- `decodeMaskToSVGPath(mask)` returns an `M/L/Z` path string, empty for an empty mask.
- `result.outcome.status` is `completed` or `incomplete`; `result.diagnostics` lists malformed or ignored lines. Treat any `error` severity diagnostic as a failed call.

Cache format decision for `data/clips/<id>/tracks/<class>.json`: per frame, per object: `{ frameIndex, objectId, bounds, confidence, mask: { encoding, width, height, payload } }`, raw payload kept so the client can decode lazily and the engine can decode once. Final shape to be stated as types before `masks.ts` is written (CLAUDE.md rule).

## 4. Box, point, and exemplar prompts on video

Box and point prompts are accepted on video. They go in `input_text` using the token grammar, not JSON, and cannot be mixed with a noun phrase in the same request:

```
<30f>1<|box;x1=10;y1=20;x2=39;y2=59;w=640;h=480|>,2<|point;x=200;y=100;w=640;h=480|>
```

- `<Nf>` picks the prompt frame; any frame may be prompted, and the same id on a later frame re-prompts the same object.
- Coordinates are media pixels (not normalized); `w,h` must equal the media's displayed size after rotation or the API returns 400.
- Negative points: prefix `-`. Boxes cannot be negative. Masks are never valid as prompts.
- Up to 16 objects. Output is always `one_bit`. `propagation_direction` controls tracking from the prompt frame.
- `buildObjectPrompt({ size, objects })` in `@meta-sam/parser` builds the string from half-open boxes and points and validates bounds.

Image-exemplar prompts (an example crop as the concept) are not offered on the Model API. The box prompt is the exemplar path. Decision for the stretch feature: the exemplar box tool is feasible as "draw a box on frame N, name it, track forward" in one SAM call with `propagation_direction: forward`. Only built after Gate 7, per SCHEDULE.md.

## 5. Muse Spark: image input and request shape

Model: `muse-spark-1.3`, Standard mode (CLAUDE.md, updated Oct 26). Never `muse-spark-1.3-contributor`: Contributor mode is cheaper but lets Meta train on the content. 1.3 accepts text, image, video, audio, PDF; 1,048,576 token context; same price as 1.1 and 1.2. `muse-spark-1.1` and `1.2` remain enabled on the account as fallbacks with the same request shape.

Yes, Muse Spark accepts image input, on both protocols. CLAUDE.md fixes the Responses API, so that is the primary shape:

Responses API, `POST /v1/responses`. Images go in a `user` message as `input_image` parts, each with `image_url` as a plain string holding a public URL or a base64 data URL (or `file_id` for a Files API upload), plus optional `detail` (`low`, `high`, `auto`, `original`; default `auto`). Structured output is `text.format`, not `response_format`; the wrong one returns 400. The docs name `text.format` but do not print a full Responses example, so the nesting below follows the OpenAI Responses convention and is item one to verify on the first Spark call.

```json
{
  "model": "muse-spark-1.3",
  "temperature": 0,
  "reasoning": { "effort": "low" },
  "max_output_tokens": 300,
  "store": false,
  "instructions": "<adjudication instructions, fixed text so the prefix caches>",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "adjudication",
      "strict": true,
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "verdict": { "type": "string", "enum": ["touching", "passing_in_front", "unclear"] },
          "reasoning": { "type": "string" }
        },
        "required": ["verdict", "reasoning"]
      }
    }
  },
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Object: IV pole. Image 1 is the first frame of the candidate window, image 2 the middle frame. Hand outline is cyan, object outline is magenta." },
        { "type": "input_image", "image_url": "data:image/png;base64,....", "detail": "high" },
        { "type": "input_image", "image_url": "data:image/png;base64,....", "detail": "high" }
      ]
    }
  ]
}
```

Verified live Oct 26 (two 96 px PNG swatches, schema with two enums and a reasoning string): this exact shape returned `status: completed` with valid JSON matching the schema in 2.0 s. Facts from that call:
- `output` has two items: a `reasoning` item first, then the `message` whose `content[0]` is `output_text` holding the JSON string. Find the message by type, do not index `output[0]`.
- Reasoning tokens count against `max_output_tokens`. With `effort: low` the call used 203 reasoning tokens plus 43 answer tokens; a cap of 200 ended the response `incomplete` with no text at all. Use at least 1,500 for adjudication and 2,500 for the narrative, and treat `status: incomplete` as a failed call to retry once with a higher cap.
- Prompt caching worked on the first call: 113 of 166 input tokens were served cached. Keep `instructions` and the schema fixed per role.
- `store: false` keeps large inline images from failing persistence (error-handling docs cite a 16 MB payload failing to persist with `store: true`).

Chat Completions equivalent, `POST /v1/chat/completions`: `messages` with a `system` entry and a `user` entry whose `content` array holds `{ type: "text" }` and `{ type: "image_url", image_url: { url } }` parts; structured output via `response_format: { type: "json_schema", json_schema: { name, strict, schema } }`; `max_completion_tokens`; `reasoning_effort` as a top-level string. This is the shape Baseten speaks, so the Baseten adapter builds it from the same prompt, images, and schema (section 7).

Muse Wonder, `muse-wonder-1.0`, is enabled and takes the identical request shape. Cost is $4.00 input and $20.00 output per million tokens, about three to five times Spark. PLAN.md reserves it as a one-evening experiment if Spark 1.3 adjudication agreement is poor on Wednesday. One adjudication on Wonder is roughly $0.03, so twelve per clip is about $0.35: affordable for a test, not for the default.

Image rules:
- Formats: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/x-icon`.
- Up to 50 images per request. Inline image up to 50 MB. Images only in `user` messages; other roles are ignored.
- Cost scales with resolution: roughly 1,300 to 1,500 input tokens for a 1280 px image. Two 720p annotated frames per adjudication is about 3,000 image tokens.
- Undecodable image returns 400.

Generation parameters:
- `temperature` 0 to 2, default 1. The docs recommend leaving it unset; we set 0 for determinism as PLAN.md requires. Use `temperature` or `top_p`, not both.
- Reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh`. `none` returns 400, so Muse Spark always reasons and reasoning tokens bill as output. Responses API: `reasoning: { effort }`. Chat Completions: top-level `reasoning_effort`. Use `low` for adjudication and narrative.
- Output cap: `max_output_tokens` on Responses (minimum 16), `max_completion_tokens` on Chat Completions. `n` must be 1. `logprobs`, `stop`, `logit_bias` rejected.
- Structured output: output is always constrained to the schema; `strict: true` additionally validates the schema (root is a plain object, `additionalProperties: false` everywhere, `required` lists every property, no `allOf`/`oneOf`, no recursion, depth 10 max). Parse and validate the returned JSON anyway (CLAUDE.md: retry once, then structured panels only).
- Structured output combines with image input per the docs.
- Streaming optional; long non-streaming requests can 504, but a 300 token adjudication will not.

Prompt caching exists (`$0.15` per million cached input tokens) and applies to a shared prefix, so keep the system prompt and schema fixed and put per-candidate content last.

## 6. Pricing and the per-clip budget

Prices (standard mode):
- SAM 3.1: $0.20 per 1,000 video frames, minimum 50 frames billed per request. $2.50 per 1,000 images.
- Muse Spark 1.1, 1.2, 1.3: $1.25 per million input tokens, $0.15 per million cached input, $4.25 per million output (reasoning tokens count as output).

Per clip at the planned sampling (10 fps, 720p, 11 classes):

| Item | Assumption | Frames or tokens | Cost |
| --- | --- | --- | --- |
| SAM, 30 s clip | 300 frames x 11 classes | 3,300 frames | $0.66 |
| SAM, 45 s clip (upload cap) | 450 frames x 11 classes | 4,950 frames | $0.99 |
| Spark vision adjudication | 12 candidates x (3,000 image + 400 text in, 600 out incl. reasoning) | 41k in, 7k out | $0.08 |
| Spark text narrative | 4k in, 1.5k out incl. reasoning | 4k in, 1.5k out | $0.01 |
| Total, 30 s clip | | | about $0.75 |
| Total, 45 s clip | | | about $1.10 |

Uploading raw 30 fps source instead of resampling would triple the SAM line ($1.98 for 30 s). Resample first.

Credits status Oct 26: $150 free credits active on the account ($149.96 after tonight's probes), card added. The billing page states that while free credits are in use, content may be used for product improvement. Every clip this project sends is staged and synthetic with no real patients, staff, or facilities, so this is acceptable, and it goes in the README privacy stance in plain words. Switching to paid balance ("Stop using free credits") removes that clause and is Rahil's call. Email usage notification set at $135 on the Billing page (Oct 26), leaving a $15 margin before the grant runs out and usage rolls onto the card. The server-side upload length cap and daily upload cap planned for Sunday are the hard stop from our side.

Against the $150 credit: feasibility clip plus dev clip plus three demo clips plus retakes is under $10 total. Every live judge upload costs at most about $1.10 with the 45 s cap. A daily upload cap of 20 bounds worst-case spend at about $22 per day. Set the spend notification at $150 on the Billing page tonight (SCHEDULE.md).

Well under the $8 per clip threshold in PLAN.md 12a, so no need to drop to 8 fps or six classes.

## 7. Muse Spark Open on Baseten (after Gate 7 only)

Per dev.meta.ai/docs/muse-spark-open/deploy: Baseten base URL `https://inference.baseten.co/v1`, model id `meta-models/muse-spark-open`, OpenAI-compatible chat completions, accepts text, image, video, and audio input. PLAN.md and CLAUDE.md name the id as `meta-models/muse-spark-open-1026`; the docs page shows `meta-models/muse-spark-open`. Verify the exact id in the Baseten console when credits are approved. The Meta backend speaks the Responses API and Baseten speaks Chat Completions, so the `SparkBackend` interface has to sit above the wire shape: each backend receives the same instructions, user text, PNG images, and JSON schema, and builds its own request (section 5 shows both shapes). Same prompts, same schemas, same cache, per CLAUDE.md. Structured output support on Baseten is unverified; the schema validation and retry path already covers it.

## 8. Decisions made tonight from the docs

1. Resample every clip with ffmpeg to 10 fps, 720p, H.264 MP4, faststart, before upload. Frame index `N` then means `t = N / 10 s` by construction, and the same frames are used for the canvas overlay, the adjudication images, and the engine.
2. Upload once per clip to the Files API, reuse `file_id` for all eleven class calls, delete the file after tracks are cached.
3. Request `mask_encoding: one_bit` and `include_confidence: "true"` on every SAM call. One bit is enough for contact geometry and is smaller to cache.
4. Depend on `@meta-sam/parser` for parsing and mask decoding. Store raw mask payloads plus bounds in the per-class track JSON. Decode to rasters in `engine/masks.ts` at the frame size for dilation and intersection.
5. Spark on the Responses API with `muse-spark-1.3` (CLAUDE.md). The `SparkBackend` interface takes instructions, user text, images, and a schema, and each backend builds its own wire request, so the Baseten chat-completions backend is an adapter, not a prompt rewrite.
6. Exemplar tool, if reached, is the SAM box prompt tracked forward from the drawn frame.
7. Spark model calls set `store: false`. Nothing in this project needs server-side conversation state, and inline images are safer without persistence.

## 9. To verify tonight on the feasibility clip (20 s, phone, bare hand, gloved hand, towel rail, remote, phone, one pass in front of the rail)

- [x] Key works and `sam-3.1` plus `muse-spark-1.3` are enabled: `GET /v1/models` returned 200 with both ids (Oct 26, 2:30 PM).
- [x] Full path proven on the cookbook `pingpong.mp4` sample (Oct 26, 3:15 PM): ffmpeg resample 23.976 fps 141 frames to 10 fps 59 frames at 1280x720, Files API upload, two streamed `sam-3.1` calls with `one_bit` and confidence, parsed with `@meta-sam/parser` 0.1.0, outcome completed, zero diagnostics. "ping pong ball": one id visible 56 of 59 frames, mean confidence 0.84, mean area 601 px. "person": two ids visible all 59 frames, confidence 0.98 and 0.96. Each call about 5 to 6 s, 59 frames billed, $0.012 per class.
- [x] `usage.video_frames_processed` equals the resampled frame count from ffprobe (59 = 59), confirming `N` indexes our 10 fps frames.
- [x] Mask raster width and height equal the record's box width and height on every record, confirming the raster covers `bounds`.
- [x] Parser 0.1.0 finalizes the text lane on the API's `response.content_part.done`; do not synthesize `response.output_text.done` as the older cookbook helper does, it throws `response_lane`.
- [ ] A text prompt call on Rahil's clip returns a completed response with records.
- [ ] "bare hand" and "gloved hand" return separate tracks that do not swap; note what the gloved class does on the bare hand and vice versa (this decides automatic glove detection vs the fallback).
- [ ] Rail, remote, and phone each get one stable id through the clip; note any id change when a hand occludes them.
- [ ] Pass in front of the rail: hand and rail masks overlap in 2D in those frames (expected; this is the case adjudication exists for).
- [ ] Mask raster decodes in Node with `decodeMaskToRaster`, dimensions match `bounds`, and a quick PNG dump looks right frame by frame.
- [ ] Latency per class call on a 200 frame clip; cost reported on the Billing page after the run.
- [ ] Whether `input_video.fps` changes `video_frames_processed` (curiosity only; we resample regardless).
- [x] One Spark Responses API call with two PNG images and a schema under `text.format` returns valid JSON at temperature 0 (Oct 26, 3:05 PM, 2.0 s, 166 in / 246 out of which 203 reasoning). Nesting in section 5 confirmed. Cap lesson recorded there.
- [ ] If masks are mush: run the same clip through fal.ai SAM 3.1 video via its JS SDK before bed and record the comparison here.

## 10. Open questions for #office-hours (post Tuesday night, one question)

Candidate: on video, does SAM 3.1 reuse an object id after that object leaves the frame and a new instance of the concept appears, or are ids never reused within one response? This decides how hand tracks are stitched when a hand leaves frame.
