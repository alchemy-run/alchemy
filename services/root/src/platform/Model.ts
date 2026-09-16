import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as AI from "alchemy/AI";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/**
 * The org's MODELS — each a named service holding a ready
 * `LanguageModel` Layer (`AI.Model`). Models are SELECTED, never
 * configured: a charter's `turn` hook calls `AI.selectModel(Opus)`,
 * and the requirement (`Opus`) charges the agent's Layer — which
 * models an agent samples with is a static, type-level fact of the
 * org. No selection → the driver's default ({@link Model}).
 */
export class Opus extends AI.Model<Opus>()("root/Opus") {}
export class Fable extends AI.Model<Fable>()("root/Fable") {}
export class Haiku extends AI.Model<Haiku>()("root/Haiku") {}
export class Gpt6Astra extends AI.Model<Gpt6Astra>()(
  "root/Gpt6Astra",
) {}
export class DeepSeekFlash extends AI.Model<DeepSeekFlash>()(
  "root/DeepSeekFlash",
) {}
export class DeepSeekPro extends AI.Model<DeepSeekPro>()(
  "root/DeepSeekPro",
) {}

/* ── implementations ────────────────────────────────────────────── */

/**
 * Claude over the Messages API. The thinking dialect is GENERATIONAL:
 * Opus 5 and Fable 5.1 only take `adaptive` (the API rejects
 * `enabled` + budget on them — probed), while Haiku 4.5 still takes
 * the explicit enabled+budget shape. Either way the traces stream to
 * the UI as reasoning deltas and land on the transcript as reasoning
 * parts.
 */
const anthropic = (model: string, thinking: "adaptive" | "enabled") =>
  AnthropicLanguageModel.make({
    model,
    config: {
      thinking:
        thinking === "adaptive"
          ? { type: "adaptive" }
          : { type: "enabled", budget_tokens: 4096 },
      max_tokens: 16384,
    },
  });

const openai = (model: string) => OpenAiLanguageModel.make({ model });

/**
 * DeepSeek over its OpenAI-compatible Responses API
 * (https://api-docs.deepseek.com/guides/responses_api) — the OpenAI
 * provider, pointed at DeepSeek's address with DeepSeek's key.
 * Thinking is on by default on both models; tools, parallel calls,
 * and reasoning items passed back on the next step all work as they
 * do against OpenAI (probed).
 *
 * Its Anthropic-compatible surface was the first choice (same factory
 * as Claude, thinking blocks and all) but its `message_start` omits
 * `usage.cache_creation`, which the Anthropic provider's schema
 * requires — every stream fails to decode.
 *
 * One seam remains: DeepSeek streams its chain of thought as
 * `response.reasoning_text.delta` (the plain-text reasoning event),
 * where OpenAI streams `response.reasoning_summary_text.delta`; the
 * provider only knows the latter, so without help the traces are
 * dropped on the floor. {@link deepseekFetch} renames the event on
 * the wire, and the thoughts reach the UI as reasoning deltas like
 * every other model's.
 */
const DEEPSEEK_URL = "https://api.deepseek.com";

/** The SSE event DeepSeek emits for reasoning text, and the one the
 *  OpenAI provider listens for (a summary part at index 0 — the id
 *  the provider opened on the reasoning item's `output_item.added`). */
const REASONING_TEXT_DELTA = "response.reasoning_text.delta";
const REASONING_SUMMARY_DELTA = "response.reasoning_summary_text.delta";

/** Rewrite one SSE line: the `event:` name and the `data:` payload's
 *  `type`, with the `summary_index` the summary shape requires. Any
 *  other line passes through byte-for-byte. */
const rewriteSseLine = (line: string): string => {
  if (line === `event: ${REASONING_TEXT_DELTA}`) {
    return `event: ${REASONING_SUMMARY_DELTA}`;
  }
  if (line.startsWith("data: ") && line.includes(REASONING_TEXT_DELTA)) {
    try {
      const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (data.type === REASONING_TEXT_DELTA) {
        return `data: ${JSON.stringify({
          ...data,
          type: REASONING_SUMMARY_DELTA,
          summary_index: 0,
        })}`;
      }
    } catch {
      // not JSON after all — leave the line alone
    }
  }
  return line;
};

/** A body transform over an SSE stream: line-buffered, so an event
 *  split across chunks is still rewritten whole. */
const rewriteSse = () => {
  let pending = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) controller.enqueue(`${rewriteSseLine(line)}\n`);
    },
    flush(controller) {
      if (pending.length > 0) controller.enqueue(rewriteSseLine(pending));
    },
  });
};

/** `fetch` with DeepSeek's event stream renamed on the way in; every
 *  non-SSE response passes through untouched. */
const deepseekFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const response = await fetch(input, init);
  const type = response.headers.get("content-type") ?? "";
  if (response.body === null || !type.includes("text/event-stream")) {
    return response;
  }
  return new Response(
    response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(rewriteSse())
      .pipeThrough(new TextEncoderStream()),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
};

const DeepSeekClient = OpenAiClient.layerConfig({
  apiKey: Config.Redacted("DEEPSEEK_API_KEY"),
  apiUrl: Config.succeed(DEEPSEEK_URL),
}).pipe(
  // `fresh`: the shared `FetchHttpClient.layer` is memoized by reference
  // across the whole build, and the first build (over the global fetch)
  // would win — this client needs its own instance over its own fetch
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, deepseekFetch as typeof fetch),
      ),
    ),
  ),
);

/**
 * Every provider over HTTP, the SAME layer on every substrate:
 * `Config.Redacted` reads each key from the deploying shell locally
 * and rides the secrets seam on Cloudflare (evaluated during the
 * Worker's init, it binds as a `secret_text`; at runtime the same
 * Config resolves from the binding — the key never enters the bundle).
 *
 * The driver annotates every compiled tool `Strict: false` —
 * Anthropic's strict tool-calling grammar caps union-typed parameters
 * per request and a real toolkit cannot fit (DriverCore.compileTool).
 */
export const ModelsLive = Layer.mergeAll(
  Opus.layer(anthropic("claude-opus-5", "adaptive")),
  Fable.layer(anthropic("claude-fable-5-1", "adaptive")),
  Haiku.layer(anthropic("claude-haiku-4-5", "enabled")),
  Gpt6Astra.layer(openai("gpt-6-astra")),
  // DeepSeek's two models over ITS client — provided here, before the
  // merge, so the OpenAI client below never reaches them
  Layer.mergeAll(
    DeepSeekFlash.layer(openai("deepseek-flash")),
    DeepSeekPro.layer(openai("deepseek-v4-pro")),
  ).pipe(Layer.provide(DeepSeekClient)),
).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(
    OpenAiClient.layerConfig({
      apiKey: Config.Redacted("OPENAI_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
  // a missing key is a deploy misconfiguration, not a runtime failure
  Layer.orDie,
);

/**
 * The driver's DEFAULT model — what a stance samples with when its
 * charter selected none. Built over the model services
 * ({@link ModelsLive}), which the agents share.
 */
export const Model: Layer.Layer<LanguageModel.LanguageModel, never, Haiku> =
  Layer.unwrap(Effect.map(Haiku, (layer) => layer));
