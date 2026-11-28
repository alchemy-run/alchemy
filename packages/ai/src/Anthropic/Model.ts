/**
 * `AI.Model` Layers on Anthropic, through Effect AI's `@effect/ai-anthropic`.
 *
 * @module
 */
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { ModelClass } from "../Model.ts";

/** Which of Anthropic's models answers, and with what key and parameters. */
export interface ModelOptions {
  /** The model's id at Anthropic, e.g. `"claude-opus-5-5"`. */
  readonly model: (string & {}) | AnthropicLanguageModel.Model;
  /**
   * The Anthropic API key. A `Config` is read where the Layer is built, in
   * the runtime's Construction phase, so the deploy binds it as a secret.
   *
   * @default Config.Redacted("ANTHROPIC_API_KEY")
   */
  readonly apiKey?: Config.Config<Redacted.Redacted<string>> | Redacted.Redacted<string>;
  /**
   * The base URL of the API, to go through a proxy or a compatible endpoint.
   *
   * @default Anthropic's own API
   */
  readonly apiUrl?: string;
  /** Request parameters every call is made with: `max_tokens, temperature`, and the rest of Anthropic's. */
  readonly parameters?: Omit<typeof AnthropicLanguageModel.Config.Service, "model">;
}

/**
 * Back a model with one of Anthropic's. The key is read from
 * `ANTHROPIC_API_KEY` unless you pass one.
 *
 * **Example:** A model on Anthropic
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AIAnthropic from "@alchemy.run/ai/Anthropic";
 *
 * export class Smart extends AI.Model<Smart>()("smart") {}
 *
 * export const SmartLive = AIAnthropic.Model(Smart, { model: "claude-opus-5-5" });
 * ```
 *
 * **Example:** A key of your own naming, and parameters
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AIAnthropic from "@alchemy.run/ai/Anthropic";
 * import * as Config from "effect/Config";
 *
 * export class Smart extends AI.Model<Smart>()("smart") {}
 *
 * export const SmartLive = AIAnthropic.Model(Smart, {
 *   model: "claude-opus-5-5",
 *   apiKey: Config.Redacted("TEAM_ANTHROPIC_API_KEY"),
 *   parameters: { temperature: 0 },
 * });
 * ```
 *
 * @layer
 * @provides AI.Model
 * @peer @effect/ai-anthropic
 */
export const Model = <Self>(
  model: ModelClass<Self, string>,
  { model: id, apiKey = Config.Redacted("ANTHROPIC_API_KEY"), apiUrl, parameters }: ModelOptions,
): Layer.Layer<Self, Config.ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Read here, while the runtime is constructed: that is what binds the secret.
      const key = Redacted.isRedacted(apiKey) ? apiKey : yield* apiKey;
      return model.layer(
        AnthropicLanguageModel.layer({ model: id, config: parameters }).pipe(
          Layer.provide(AnthropicClient.layer({ apiKey: key, apiUrl })),
          Layer.provide(FetchHttpClient.layer),
        ),
      );
    }),
  );
