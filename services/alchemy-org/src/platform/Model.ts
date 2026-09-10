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

/**
 * The CATALOG the selector shows, in display order: the id the UI
 * writes into a thread's books, its label, and the service it names.
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
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

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
  Sonnet | Opus | Haiku | Gpt5 | Gpt5Mini
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
 * Both providers over HTTP, the SAME layer on every substrate:
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
export const Model: Layer.Layer<
  LanguageModel.LanguageModel,
  never,
  Sonnet | Opus | Haiku | Gpt5 | Gpt5Mini
> = Layer.unwrap(Effect.map(models, (pick) => pick(undefined)));
