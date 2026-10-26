# API notes: Meta Model API, SAM 3.1 video and Muse Spark

Written Mon Oct 26, 2026 (Gate 1) from the official docs at dev.meta.ai, the `@meta-sam/parser` 0.1.0 package, and the `meta-models/meta-sam` protocol spec. Nothing here has been confirmed against a live call yet. Section 9 lists what the feasibility clip must verify tonight.

Sources: dev.meta.ai/docs/sam/overview, /docs/sam/segmenting, /docs/sam/reading-segmentation, /docs/sam/client-libraries, /docs/protocols/responses, /docs/protocols/chat-completions, /docs/image-understanding, /docs/structured-output, /docs/file-handling, /docs/pricing-rate-limits, /docs/error-handling, /docs/api-reference/responses/schemas, /docs/models, /docs/muse-spark-open/deploy, github.com/meta-models/meta-sam (protocol/sam3.md), npm @meta-sam/parser 0.1.0.

## 1. Common

- Base URL: `https://api.meta.ai/v1`
- Auth: `Authorization: Bearer <META_MODEL_API_KEY>` on every call. Docs call the variable `MODEL_API_KEY`; ours is `META_MODEL_API_KEY` in `.env`.
- OpenAI compatible. The `openai` npm package works with `baseURL` set to the base URL. Raw `fetch` with server-sent events also works.
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
- The docs do not state whether `N` counts source frames or resampled frames, and give no fps. We resolve this by construction: ffmpeg resamples every clip to a constant 10 fps before upload, so frame `N` is at `t = N / 10` seconds. `usage.video_frames_processed` on the response should equal the resampled frame count; verify tonight.

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

Model ids available: `muse-spark-1.1` (original, standard mode only), `muse-spark-1.2`, `muse-spark-1.3` (docs recommend for new work). All three accept text, image, video, audio, PDF; 1,048,576 token context; identical pricing. CLAUDE.md fixes 1.1. Flag for Rahil: 1.3 costs the same and is the documented default; switching is a one-string change in config, not a decision to make tonight.

Yes, Muse Spark accepts image input, on both protocols:

Chat Completions, `POST /v1/chat/completions`. Image goes in the `content` array of a `user` message as an `image_url` part whose value is an object with a `url` field holding a public URL or a base64 data URL. This is the shape the Baseten backend will share later, so it is our choice for both Spark roles.

```json
{
  "model": "muse-spark-1.1",
  "temperature": 0,
  "reasoning_effort": "low",
  "max_completion_tokens": 300,
  "response_format": {
    "type": "json_schema",
    "json_schema": {
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
  "messages": [
    { "role": "system", "content": "<adjudication instructions>" },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Object: IV pole. Frame 1 is the first frame of the candidate window, frame 2 the middle frame. Hand outline is cyan, object outline is magenta." },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,...." } },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,...." } }
      ]
    }
  ]
}
```

Responses API alternative: `input_image` part with `image_url` as a plain string (URL or data URL) or `file_id`, plus optional `detail` (`low`, `high`, `auto`, `original`). Structured output there uses `text.format`, not `response_format`; the two are not interchangeable and the wrong one returns 400.

Image rules:
- Formats: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/x-icon`.
- Up to 50 images per request. Inline image up to 50 MB. Images only in `user` messages; other roles are ignored.
- Cost scales with resolution: roughly 1,300 to 1,500 input tokens for a 1280 px image. Two 720p annotated frames per adjudication is about 3,000 image tokens.
- Undecodable image returns 400.

Generation parameters:
- `temperature` 0 to 2, default 1. The docs recommend leaving it unset; we set 0 for determinism as PLAN.md requires. Use `temperature` or `top_p`, not both.
- `reasoning_effort`: `minimal`, `low`, `medium`, `high`, `xhigh`. `none` returns 400, so Muse Spark always reasons and reasoning tokens bill as output. Use `low` for adjudication and narrative.
- `max_completion_tokens` (not `max_tokens`). `n` must be 1. `logprobs`, `stop`, `logit_bias` rejected.
- Structured output: `response_format: { type: "json_schema", json_schema: { name, schema, strict } }`. Output is always constrained to the schema; `strict: true` additionally validates the schema (root is a plain object, `additionalProperties: false` everywhere, `required` lists every property, no `allOf`/`oneOf`, no recursion). Response text is a JSON string in `choices[0].message.content`; parse and validate it anyway (CLAUDE.md: retry once, then structured panels only).
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

Against the $150 credit: feasibility clip plus dev clip plus three demo clips plus retakes is under $10 total. Every live judge upload costs at most about $1.10 with the 45 s cap. A daily upload cap of 20 bounds worst-case spend at about $22 per day. Set the spend notification at $150 on the Billing page tonight (SCHEDULE.md).

Well under the $8 per clip threshold in PLAN.md 12a, so no need to drop to 8 fps or six classes.

## 7. Muse Spark Open on Baseten (after Gate 7 only)

Per dev.meta.ai/docs/muse-spark-open/deploy: Baseten base URL `https://inference.baseten.co/v1`, model id `meta-models/muse-spark-open`, OpenAI-compatible chat completions, accepts text, image, video, and audio input. PLAN.md names the id as `meta-models/muse-spark-open-1026`; the docs page shows `meta-models/muse-spark-open`. Verify the exact id in the Baseten console when credits are approved. Because we use Chat Completions with `image_url` parts for the Meta backend, the Baseten backend is the same request with a different base URL, key, and model id. Structured output support on Baseten is unverified; the schema validation and retry path already covers it.

## 8. Decisions made tonight from the docs

1. Resample every clip with ffmpeg to 10 fps, 720p, H.264 MP4, faststart, before upload. Frame index `N` then means `t = N / 10 s` by construction, and the same frames are used for the canvas overlay, the adjudication images, and the engine.
2. Upload once per clip to the Files API, reuse `file_id` for all eleven class calls, delete the file after tracks are cached.
3. Request `mask_encoding: one_bit` and `include_confidence: "true"` on every SAM call. One bit is enough for contact geometry and is smaller to cache.
4. Depend on `@meta-sam/parser` for parsing and mask decoding. Store raw mask payloads plus bounds in the per-class track JSON. Decode to rasters in `engine/masks.ts` at the frame size for dilation and intersection.
5. Use Chat Completions for both Spark roles so the Baseten backend is a config swap.
6. Exemplar tool, if reached, is the SAM box prompt tracked forward from the drawn frame.

## 9. To verify tonight on the feasibility clip (20 s, phone, bare hand, gloved hand, towel rail, remote, phone, one pass in front of the rail)

- [ ] Key works: a text prompt call on the clip returns a completed response with records.
- [ ] `usage.video_frames_processed` equals the resampled frame count from ffprobe, confirming `N` indexes our 10 fps frames.
- [ ] "bare hand" and "gloved hand" return separate tracks that do not swap; note what the gloved class does on the bare hand and vice versa (this decides automatic glove detection vs the fallback).
- [ ] Rail, remote, and phone each get one stable id through the clip; note any id change when a hand occludes them.
- [ ] Pass in front of the rail: hand and rail masks overlap in 2D in those frames (expected; this is the case adjudication exists for).
- [ ] Mask raster decodes in Node with `decodeMaskToRaster`, dimensions match `bounds`, and a quick PNG dump looks right frame by frame.
- [ ] Latency per class call on a 200 frame clip; cost reported on the Billing page after the run.
- [ ] Whether `input_video.fps` changes `video_frames_processed` (curiosity only; we resample regardless).
- [ ] One Spark Chat Completions call with two PNG images and the adjudication schema returns valid JSON at temperature 0.
- [ ] If masks are mush: run the same clip through fal.ai SAM 3.1 video via its JS SDK before bed and record the comparison here.

## 10. Open questions for #office-hours (post Tuesday night, one question)

Candidate: on video, does SAM 3.1 reuse an object id after that object leaves the frame and a new instance of the concept appears, or are ids never reused within one response? This decides how hand tracks are stitched when a hand leaves frame.
