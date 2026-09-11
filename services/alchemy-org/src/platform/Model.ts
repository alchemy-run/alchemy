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
 * `LanguageModel` Layer (`AI.Model`). A charter picks one by providing
 * it to its stance: `AI.fragment`…``.pipe(Effect.provide(sonnet))`.
 */
export class Sonnet extends AI.Model<Sonnet>()("alchemy-org/Sonnet") {}
export class Opus extends AI.Model<Opus>()("alchemy-org/Opus") {}
export class Haiku extends AI.Model<Haiku>()("alchemy-org/Haiku") {}
export class Gpt5 extends AI.Model<Gpt5>()("alchemy-org/Gpt5") {}
export class Gpt5Mini extends AI.Model<Gpt5Mini>()("alchemy-org/Gpt5Mini") {}
export class DeepSeekFlash extends AI.Model<DeepSeekFlash>()(
  "alchemy-org/DeepSeekFlash",
) {}
export class DeepSeekPro extends AI.Model<DeepSeekPro>()(
  "alchemy-org/DeepSeekPro",
) {}

/**
 * The CATALOG the selector shows, in display order: the id the UI
 * writes into a thread's state, its label, and the service it names.
 * `DEFAULT_MODEL` is what a stance samples with when its thread chose
 * nothing.
 */
export const MODELS = [
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    provider: "anthropic",
    model: Sonnet,
  },
  {
    id: "claude-opus-4-1",
    label: "Claude Opus 4.1",
    provider: "anthropic",
    model: Opus,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    model: Haiku,
  },
  { id: "gpt-5", label: "GPT-5", provider: "openai", model: Gpt5 },
  {
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    provider: "openai",
    model: Gpt5Mini,
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    model: DeepSeekFlash,
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    model: DeepSeekPro,
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

/** The catalog's services — what holding every model requires. */
export type Catalog =
  | Sonnet
  | Opus
  | Haiku
  | Gpt5
  | Gpt5Mini
  | DeepSeekFlash
  | DeepSeekPro;

export const DEFAULT_MODEL: ModelId = "claude-haiku-4-5";

/** What `GET /api/models` serves — the catalog minus the services. */
export const catalog = MODELS.map(({ id, label, provider }) => ({
  id,
  label,
  provider,
}));

/**
 * Every catalog model, keyed by id — a charter yields this once at
 * init and indexes it with the thread's pick per tick. Unknown ids
 * fall back to the default, so a model retired from the catalog never
 * strands the threads that chose it.
 */
export const models: Effect.Effect<
  (id: string | undefined) => AI.ModelLayer,
  never,
  Catalog
> = Effect.gen(function* () {
  const byId = new Map<string, AI.ModelLayer>();
  for (const entry of MODELS) byId.set(entry.id, yield* entry.model);
  const fallback = byId.get(DEFAULT_MODEL)!;
  return (id) => (id === undefined ? fallback : (byId.get(id) ?? fallback));
});

/* ── implementations ────────────────────────────────────────────── */

const anthropic = (model: string) =>
  AnthropicLanguageModel.make({
    model,
    config: {
      // extended thinking: the traces stream to the UI as reasoning
      // deltas and land on the transcript as reasoning parts
      thinking: { type: "enabled", budget_tokens: 4096 },
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
  apiKey: Config.redacted("DEEPSEEK_API_KEY"),
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
 * `Config.redacted` reads each key from the deploying shell locally
 * and rides the secrets seam on Cloudflare (evaluated during the
 * Worker's init, it binds as a `secret_text`; at runtime the same
 * Config resolves from the binding — the key never enters the bundle).
 *
 * The driver annotates every compiled tool `Strict: false` —
 * Anthropic's strict tool-calling grammar caps union-typed parameters
 * per request and a real toolkit cannot fit (DriverCore.compileTool).
 */
export const ModelsLive = Layer.mergeAll(
  Sonnet.layer(anthropic("claude-sonnet-4-5")),
  Opus.layer(anthropic("claude-opus-4-1")),
  Haiku.layer(anthropic("claude-haiku-4-5")),
  Gpt5.layer(openai("gpt-5")),
  Gpt5Mini.layer(openai("gpt-5-mini")),
  // DeepSeek's two models over ITS client — provided here, before the
  // merge, so the OpenAI client below never reaches them
  Layer.mergeAll(
    DeepSeekFlash.layer(openai("deepseek-flash")),
    DeepSeekPro.layer(openai("deepseek-v4-pro")),
  ).pipe(Layer.provide(DeepSeekClient)),
).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(
    OpenAiClient.layerConfig({
      apiKey: Config.redacted("OPENAI_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
  // a missing key is a deploy misconfiguration, not a runtime failure
  Layer.orDie,
);

/**
 * The driver's DEFAULT model — what a stance samples with when it was
 * provided none. The default IS one of the catalog's, so the selector
 * always offers what an unconfigured thread runs on. Built over the
 * catalog services ({@link ModelsLive}), which the agents share.
 */
export const Model: Layer.Layer<LanguageModel.LanguageModel, never, Catalog> =
  Layer.unwrap(Effect.map(models, (pick) => pick(undefined)));
