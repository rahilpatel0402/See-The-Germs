// npm run spark-probe -- <meta|baseten|fireworks>
// Sends the same two-swatch structured-output test through the named backend: two inline PNGs,
// a strict JSON schema, temperature 0. Prints the parsed answer, usage, and timing.
import "../env.ts";
import { deflateSync } from "node:zlib";
import { createSparkBackend } from "../spark.ts";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(tag: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(r: number, g: number, b: number, size = 96): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())]);
  const raw = Buffer.concat(Array(size).fill(row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const name = process.argv[2] ?? "meta";
const backend = createSparkBackend(name);
console.log(`backend ${backend.name}, model ${backend.model}`);
try {
  const result = await backend.completeJson({
    instructions: "You classify solid color swatches. Answer only with the JSON the schema allows.",
    text: "Two images follow. Name the dominant color of each, in order.",
    images: [solidPng(220, 30, 30), solidPng(30, 60, 220)],
    schemaName: "swatches",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        first_image_color: { type: "string", enum: ["red", "green", "blue", "unclear"] },
        second_image_color: { type: "string", enum: ["red", "green", "blue", "unclear"] },
        reasoning: { type: "string" },
      },
      required: ["first_image_color", "second_image_color", "reasoning"],
    },
    maxOutputTokens: 1500,
  });
  console.log("answer:", JSON.stringify(result.json));
  console.log("usage:", JSON.stringify(result.usage), `${result.elapsedMs} ms`);
} catch (err) {
  const e = err as { status?: number; message?: string; error?: unknown };
  console.error("FAILED", e.status ?? "", e.message ?? "", e.error ? JSON.stringify(e.error).slice(0, 400) : "");
  process.exit(1);
}
