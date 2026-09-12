/**
 * MODELS — named `LanguageModel` Layers, chosen by the charter.
 *
 * The driver's own `LanguageModel` Layer is the DEFAULT: a stance
 * that says nothing samples with it. A charter picks a different one
 * by PROVIDING it to the stance — plain `Effect.provide`, nothing
 * else: `AI.fragment` records the `LanguageModel` in scope when it is
 * evaluated, and the driver samples with what the returned Fragment
 * recorded. Around a static stance it holds for the session; inside a
 * turn it is per tick — routing by turn is the same line in a
 * different place.
 *
 * `AI.Model` names one such model as a service, so the org declares
 * its models once and provides them like anything else:
 *
 * ```ts
 * export class Sonnet extends AI.Model<Sonnet>()("Sonnet") {}
 * export class Gpt5   extends AI.Model<Gpt5>()("Gpt5") {}
 *
 * export const SonnetLive = Sonnet.layer(
 *   AnthropicLanguageModel.make({ model: "claude-sonnet-4-5" }),
 * );
 * export const Gpt5Live = Gpt5.layer(OpenAiLanguageModel.make({ model: "gpt-5" }));
 *
 * // a charter
 * const sonnet = yield* Sonnet;
 * return AI.fragment`...`.pipe(Effect.provide(sonnet));
 * ```
 *
 * `yield* Sonnet` is a `Layer<LanguageModel.LanguageModel>`, built ONCE
 * when `SonnetLive` builds — providing it to a stance costs nothing
 * per tick. The transcript's `assistant` observation records the
 * model the wire reports (`response-metadata`) and its token usage.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";

/** What a Model service holds: a ready Layer for `LanguageModel`. */
export type ModelLayer = Layer.Layer<LanguageModel.LanguageModel>;

/**
 * A named model: a `Context.Service` whose value is a ready
 * {@link ModelLayer}, plus two constructors for its implementation.
 */
export interface Model<Self> extends Context.ServiceClass<
  Self,
  string,
  ModelLayer
> {
  /**
   * The implementation Layer: build the `LanguageModel.LanguageModel` (a
   * provider's `make`) and hold it as this model's ready Layer.
   */
  readonly layer: <E, R>(
    service: Effect.Effect<LanguageModel.LanguageModel, E, R>,
  ) => Layer.Layer<Self, E, R>;
}

/**
 * `AI.Model<Self>()(name)` — a `Context.Service<Self, ModelLayer>`
 * with `layer` attached. Nothing more: models are not terms, they are
 * never mentioned in prose.
 */
export const Model: {
  <Self>(): {
    (name: string): Model<Self>;
  };
} = (() => (name: string) => {
  const cls = class extends (Context.Service<any, any>()(name) as any) {};
  const ready = (service: LanguageModel.LanguageModel): ModelLayer =>
    Layer.succeed(LanguageModel.LanguageModel, service);
  return Object.assign(cls, {
    layer: (service: Effect.Effect<LanguageModel.LanguageModel, any, any>) =>
      Layer.effect(cls as any, Effect.map(service, ready)),
  });
}) as any;
