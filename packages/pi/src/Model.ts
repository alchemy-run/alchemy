import { LanguageModel } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelOptions } from "./internal/provider.ts";

export type { ModelOptions } from "./internal/provider.ts";

const ModelTypeId = "~alchemy/Pi/Model" as const;

/**
 * A model a harness can run conversations on, named once and backed by an
 * Effect AI `LanguageModel` Layer. Conversations store the name; which LLM
 * answers is the Layer you provide.
 */
export interface ModelClass<Self, Name extends string> extends Context.ServiceClass<
  Self,
  `Pi.Model/${Name}`,
  LanguageModel.LanguageModel
> {
  readonly [ModelTypeId]: true;
  readonly modelName: Name;
  readonly options: ModelOptions;
  /** Back this model with an Effect AI `LanguageModel` Layer. */
  layer<E, R>(
    languageModel: Layer.Layer<LanguageModel.LanguageModel, E, R>,
  ): Layer.Layer<Self, E, R>;
}

export type AnyModel = ModelClass<any, string>;

export const isModel = (u: unknown): u is AnyModel =>
  typeof u === "function" && u !== null && ModelTypeId in u;

/**
 * Declare a model.
 *
 * **Example:** A model backed by Workers AI through an AI Gateway
 * ```typescript
 * export class Fast extends Pi.Model<Fast>()("fast") {}
 *
 * export const FastLive = Fast.layer(
 *   Cloudflare.AI.makeLanguageModelLayer({ client: gateway, model: "@cf/zai-org/glm-5.3-flash" }),
 * );
 * ```
 */
export const Model =
  <Self>() =>
  <const Name extends string>(name: Name, options: ModelOptions = {}): ModelClass<Self, Name> => {
    const Tag = Context.Service<Self, LanguageModel.LanguageModel>()(`Pi.Model/${name}`);
    return class extends Tag {
      static readonly [ModelTypeId] = true;
      static readonly modelName = name;
      static readonly options = options;
      static layer<E, R>(languageModel: Layer.Layer<LanguageModel.LanguageModel, E, R>) {
        return Layer.effect(this as never, Effect.service(LanguageModel.LanguageModel)).pipe(
          Layer.provide(languageModel),
        );
      }
    } as unknown as ModelClass<Self, Name>;
  };
