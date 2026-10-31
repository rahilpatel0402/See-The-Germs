// Muse Spark behind a SparkBackend interface. The Meta Model API backend speaks the Responses
// API; the open-weight backends (Muse Spark Open on Baseten or Fireworks) build an OpenAI-style
// chat completion from the same request. Same prompts, same schemas, same validation.
// Spark only ever gets what the caller hands it: an instruction, a short text, PNG images, and
// a JSON schema. It never sees clinical rules or confident contacts.
import OpenAI from "openai";
import { optionalEnv, requireEnv } from "./env.ts";
import { META_BASE_URL } from "./sam.ts";

export interface SparkRequest {
  readonly instructions: string;
  readonly text: string;
  readonly images: readonly Buffer[];
  readonly schemaName: string;
  readonly schema: object;
  readonly maxOutputTokens: number;
}

export interface SparkUsage {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface SparkResult {
  readonly json: unknown;
  readonly usage: SparkUsage;
  readonly elapsedMs: number;
}

export interface SparkBackend {
  readonly name: string;
  readonly model: string;
  completeJson(request: SparkRequest): Promise<SparkResult>;
}

// Published Standard mode prices per token.
const PRICE_IN = 1.25 / 1_000_000;
const PRICE_CACHED = 0.15 / 1_000_000;
const PRICE_OUT = 4.25 / 1_000_000;

export function estimateSparkCost(usage: SparkUsage): number {
  return (usage.inputTokens - usage.cachedTokens) * PRICE_IN + usage.cachedTokens * PRICE_CACHED + usage.outputTokens * PRICE_OUT;
}

let client: OpenAI | null = null;
function metaClient(): OpenAI {
  if (!client) client = new OpenAI({ baseURL: META_BASE_URL, apiKey: requireEnv("MODEL_API_KEY") });
  return client;
}

// Strips a ```json fence if a chat model wraps its answer in one.
function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

// Muse Spark Open served by a partner on an OpenAI-compatible chat completions endpoint.
// Structured output is requested as json_schema; if the provider rejects that, the schema is
// restated in the system prompt and json_object mode is used, and the caller validates anyway.
export class OpenAICompatSparkBackend implements SparkBackend {
  readonly name: string;
  readonly model: string;
  private readonly client: OpenAI;
  private jsonSchemaSupported = true;

  constructor(name: string, baseURL: string, apiKey: string, model: string) {
    this.name = name;
    this.model = model;
    this.client = new OpenAI({ baseURL, apiKey });
  }

  // Muse Spark Open reasons inside the completion budget and spends more of it than the hosted
  // model does, so the cap never goes below this on an open-weight backend.
  private static readonly MIN_OUTPUT_TOKENS = 6000;

  async completeJson(request: SparkRequest): Promise<SparkResult> {
    const started = Date.now();
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text: request.text }];
    for (const png of request.images) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } });
    const schemaNote = `\n\nAnswer with a single JSON object matching this JSON schema and nothing else:\n${JSON.stringify(request.schema)}`;

    const call = async (useSchema: boolean) =>
      this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_completion_tokens: Math.max(request.maxOutputTokens, OpenAICompatSparkBackend.MIN_OUTPUT_TOKENS),
        messages: [
          { role: "system", content: useSchema ? request.instructions : request.instructions + schemaNote },
          { role: "user", content },
        ],
        response_format: useSchema
          ? { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: request.schema as Record<string, unknown> } }
          : { type: "json_object" },
      });

    let completion;
    try {
      completion = await call(this.jsonSchemaSupported);
    } catch (err) {
      const { status, message } = err as { status?: number; message?: string };
      // Only a 400 that names the response format means the provider rejects json_schema. Any
      // other 400 (payload too large, bad model id) is the caller's problem and is rethrown.
      if (!this.jsonSchemaSupported || status !== 400 || !/response_format|json_schema/i.test(message ?? "")) throw err;
      this.jsonSchemaSupported = false;
      console.log(`spark   | ${this.name} | provider rejected json_schema (${(message ?? "").slice(0, 80)}); using json_object with the schema in the prompt from now on`);
      completion = await call(false);
    }
    const choice = completion.choices[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const why = choice?.finish_reason === "length" ? "ran out of output tokens before answering (reasoning used the budget)" : `finish ${choice?.finish_reason ?? "unknown"}`;
      throw new Error(`${this.name}: empty completion, ${why}`);
    }
    let json: unknown;
    try {
      json = parseJsonText(text);
    } catch {
      throw new Error(`${this.name}: output is not JSON: ${text.slice(0, 200)}`);
    }
    const u = completion.usage;
    const reasoning = (u as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)?.completion_tokens_details?.reasoning_tokens ?? 0;
    const cached = (u as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      json,
      usage: { inputTokens: u?.prompt_tokens ?? 0, cachedTokens: cached, outputTokens: u?.completion_tokens ?? 0, reasoningTokens: reasoning },
      elapsedMs: Date.now() - started,
    };
  }
}

export type SparkBackendName = "meta" | "baseten" | "fireworks";

// The backend named by SPARK_BACKEND (default meta), or an explicit name. Partner model ids and
// base URLs follow dev.meta.ai/docs/muse-spark-open/deploy and can be overridden by env.
export function createSparkBackend(name: string = optionalEnv("SPARK_BACKEND", "meta")): SparkBackend {
  switch (name) {
    case "meta":
      return new MetaSparkBackend();
    case "baseten":
      return new OpenAICompatSparkBackend(
        "baseten",
        optionalEnv("BASETEN_BASE_URL", "https://inference.baseten.co/v1"),
        requireEnv("BASETEN_API_KEY"),
        optionalEnv("BASETEN_MODEL", "meta-models/muse-spark-open"),
      );
    case "fireworks":
      return new OpenAICompatSparkBackend(
        "fireworks",
        optionalEnv("FIREWORKS_BASE_URL", "https://api.fireworks.ai/inference/v1"),
        process.env["FIREWORKS_API_KEY"] || process.env["FIREWORK_API_KEY"] || requireEnv("FIREWORKS_API_KEY"),
        optionalEnv("FIREWORKS_MODEL", "accounts/fireworks/models/muse-spark-open"),
      );
    default:
      throw new Error(`SPARK_BACKEND must be meta, baseten, or fireworks, got "${name}"`);
  }
}

export class MetaSparkBackend implements SparkBackend {
  readonly name = "meta-model-api";
  readonly model = "muse-spark-1.3";

  async completeJson(request: SparkRequest): Promise<SparkResult> {
    const started = Date.now();
    const content: unknown[] = [{ type: "input_text", text: request.text }];
    for (const png of request.images) {
      content.push({ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "high" });
    }
    const response = (await metaClient().responses.create({
      model: this.model,
      temperature: 0,
      reasoning: { effort: "low" },
      max_output_tokens: request.maxOutputTokens,
      store: false,
      instructions: request.instructions,
      text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.schema } },
      input: [{ type: "message", role: "user", content }],
    } as never)) as unknown as {
      status?: string;
      incomplete_details?: { reason?: string } | null;
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
    };
    const usage: SparkUsage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    };
    if (response.status !== "completed") {
      throw new Error(`Spark: response ${response.status ?? "unknown"} (${response.incomplete_details?.reason ?? "no reason"}), ${usage.reasoningTokens} reasoning tokens`);
    }
    const message = response.output?.find((item) => item.type === "message");
    const text = message?.content?.find((part) => part.type === "output_text")?.text;
    if (text === undefined) throw new Error("Spark: no output_text in response");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Spark: output is not JSON: ${text.slice(0, 200)}`);
    }
    return { json, usage, elapsedMs: Date.now() - started };
  }
}
