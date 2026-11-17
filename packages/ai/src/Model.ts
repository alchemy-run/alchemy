import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { LanguageModel } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const ModelTypeId = "~alchemy/AI/Model" as const;

/** What a harness needs to know about a model beyond its name. */
export interface ModelOptions {
  /** Tokens of context the model accepts. @default 128000 */
  readonly contextWindow?: number;
  /** Most tokens one answer may have. @default 8192 */
  readonly maxTokens?: number;
  /** Whether the model accepts images. @default false */
  readonly images?: boolean;
}

/**
 * A model a harness can run conversations on, named once and backed by an
 * Effect AI `LanguageModel` Layer. Conversations store the name; which LLM
 * answers is the Layer you provide.
 */
export interface ModelClass<Self, Name extends string> extends Context.ServiceClass<
  Self,
  `AI.Model/${Name}`,
  ModelService
> {
  readonly [ModelTypeId]: true;
  readonly modelName: Name;
  readonly options: ModelOptions;
  /**
   * Back this model with an Effect AI `LanguageModel` Layer. It is built
   * when an instance first opens its harness, so it may need the runtime
   * context (a Worker's AI binding); everything else it needs is taken
   * from where this Layer is provided.
   */
  layer<E, R>(
    languageModel: Layer.Layer<LanguageModel.LanguageModel, E, R>,
  ): Layer.Layer<Self, never, Exclude<R, RuntimeContext>>;
}

/**
 * What a model tag holds: its `LanguageModel` Layer, with the services it
 * needed where it was provided already applied. A harness builds it when
 * an instance opens, where the runtime context exists.
 */
export interface ModelService {
  readonly languageModel: Layer.Layer<LanguageModel.LanguageModel, unknown, RuntimeContext>;
}

export type AnyModel = ModelClass<any, string>;

export const isModel = (u: unknown): u is AnyModel =>
  typeof u === "function" && u !== null && ModelTypeId in u;

/**
 * Declare a model. The same declaration runs on any harness.
 *
 * **Example:** A model backed by Workers AI
 * ```typescript
 * export class Fast extends AI.Model<Fast>()("fast") {}
 *
 * export const FastLive = Layer.unwrap(
 *   Effect.gen(function* () {
 *     const ai = yield* Cloudflare.Workers.AI();
 *     return Fast.layer(ai.model({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }));
 *   }),
 * ).pipe(Layer.provide(Cloudflare.Workers.AIBinding));
 * ```
 */
export const Model =
  <Self>() =>
  <const Name extends string>(name: Name, options: ModelOptions = {}): ModelClass<Self, Name> => {
    const Tag = Context.Service<Self, ModelService>()(`AI.Model/${name}`);
    return class extends Tag {
      static readonly [ModelTypeId] = true;
      static readonly modelName = name;
      static readonly options = options;
      static layer<E, R>(languageModel: Layer.Layer<LanguageModel.LanguageModel, E, R>) {
        return Layer.effect(
          this as never,
          Effect.map(Effect.context<never>(), (context) => ({
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the captured context holds everything but the runtime context
            languageModel: Layer.provide(
              languageModel,
              Layer.succeedContext(context),
            ) as Layer.Layer<LanguageModel.LanguageModel, unknown, RuntimeContext>,
          })),
        );
      }
    } as unknown as ModelClass<Self, Name>;
  };
