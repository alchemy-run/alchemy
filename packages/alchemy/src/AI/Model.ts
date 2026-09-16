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
import * as Option from "effect/Option";
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

/**
 * The tick's model SELECTION — an internal, driver-provided holder a
 * turn hook writes through {@link selectModel}. Provided by the
 * driver around the hook's evaluation only; part of the frame (like
 * `AI.Tick`), never something a user Layer provides.
 */
export class TickModel extends Context.Service<
  TickModel,
  { readonly select: (model: ModelLayer) => void }
>()("alchemy/AI/TickModel") {}

/**
 * SELECT the model this tick samples with — from a turn hook:
 *
 * ```ts
 * Head.make`…`({
 *   turn: Effect.gen(function* () {
 *     yield* AI.selectModel(ClaudeHaiku45);
 *   }),
 * });
 * ```
 *
 * The requirement is inferred: `selectModel(ClaudeHaiku45)` types as
 * `Effect<void, never, ClaudeHaiku45>` — the agent's Layer must be
 * provided the model implementation (`ClaudeHaiku45Live`), so WHICH
 * models an agent can sample with is a static, type-level fact of the
 * org. Without a selection the driver's default `LanguageModel`
 * samples, as always.
 */
export const selectModel = <Self>(
  model: Model<Self>,
): Effect.Effect<void, never, Self> =>
  Effect.gen(function* () {
    const holder = yield* Effect.serviceOption(TickModel);
    if (Option.isNone(holder)) {
      return yield* Effect.die(
        "AI.selectModel: no tick in scope — select the model from a turn hook (the `turn` key of the charter's methods record)",
      );
    }
    holder.value.select(yield* model as never as Effect.Effect<ModelLayer>);
  }) as never;
