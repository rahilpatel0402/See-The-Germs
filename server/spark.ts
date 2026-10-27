// Muse Spark behind a SparkBackend interface. The Meta Model API backend speaks the Responses
// API; the Baseten backend (after Gate 7) builds a chat completion from the same request.
// Spark only ever gets what the caller hands it: an instruction, a short text, PNG images, and
// a JSON schema. It never sees clinical rules or confident contacts.
import OpenAI from "openai";
import { requireEnv } from "./env.ts";
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
