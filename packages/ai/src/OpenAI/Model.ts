/**
 * `AI.Model` Layers on OpenAI, through Effect AI's `@effect/ai-openai`.
 *
 * @module
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { ModelClass } from "../Model.ts";

/** Which of OpenAI's models answers, and with what key and parameters. */
export interface ModelOptions {
  /** The model's id at OpenAI, e.g. `"gpt-5.4-mini"`. */
  readonly model: (string & {}) | OpenAiLanguageModel.Model;
  /**
   * The OpenAI API key. A `Config` is read where the Layer is built, in
   * the runtime's Construction phase, so the deploy binds it as a secret.
   *
   * @default Config.Redacted("OPENAI_API_KEY")
   */
  readonly apiKey?: Config.Config<Redacted.Redacted<string>> | Redacted.Redacted<string>;
  /**
   * The base URL of the API, to go through a proxy or a compatible endpoint.
   *
   * @default OpenAI's own API
   */
  readonly apiUrl?: string;
  /** Request parameters every call is made with: `temperature, reasoning`, and the rest of OpenAI's. */
  readonly parameters?: Omit<typeof OpenAiLanguageModel.Config.Service, "model">;
}

/**
 * Back a model with one of OpenAI's. The key is read from
 * `OPENAI_API_KEY` unless you pass one.
 *
 * **Example:** A model on OpenAI
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AIOpenAI from "@alchemy.run/ai/OpenAI";
 *
 * export class Smart extends AI.Model<Smart>()("smart") {}
 *
 * export const SmartLive = AIOpenAI.Model(Smart, { model: "gpt-5.4-mini" });
 * ```
 *
 * **Example:** A key of your own naming, and parameters
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AIOpenAI from "@alchemy.run/ai/OpenAI";
 * import * as Config from "effect/Config";
 *
 * export class Smart extends AI.Model<Smart>()("smart") {}
 *
 * export const SmartLive = AIOpenAI.Model(Smart, {
 *   model: "gpt-5.4-mini",
 *   apiKey: Config.Redacted("TEAM_OPENAI_API_KEY"),
 *   parameters: { temperature: 0 },
 * });
 * ```
 *
 * @layer
 * @provides AI.Model
 * @peer @effect/ai-openai
 */
export const Model = <Self>(
  model: ModelClass<Self, string>,
  { model: id, apiKey = Config.Redacted("OPENAI_API_KEY"), apiUrl, parameters }: ModelOptions,
): Layer.Layer<Self, Config.ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Read here, while the runtime is constructed: that is what binds the secret.
      const key = Redacted.isRedacted(apiKey) ? apiKey : yield* apiKey;
      return model.layer(
        OpenAiLanguageModel.layer({ model: id, config: parameters }).pipe(
          Layer.provide(OpenAiClient.layer({ apiKey: key, apiUrl })),
          Layer.provide(FetchHttpClient.layer),
        ),
      );
    }),
  );
