import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/**
 * The model — Anthropic over HTTP, the SAME layer on every substrate:
 * `Config.redacted` reads the key from the deploying shell locally and
 * rides the secrets seam on Cloudflare (evaluated during the Worker's
 * init, it binds as a `secret_text`; at runtime the same Config
 * resolves from the binding — the key never enters the bundle).
 *
 * The driver annotates every compiled tool `Strict: false` —
 * Anthropic's strict tool-calling grammar caps union-typed parameters
 * per request and a real toolkit cannot fit (DriverCore.compileTool).
 */
export const Model = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
  config: {
    // extended thinking: the traces stream to the UI as reasoning
    // deltas and land on the transcript as reasoning parts
    thinking: { type: "enabled", budget_tokens: 4096 },
    max_tokens: 16384,
  },
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);
