import type { Types, Unify } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Inspectable } from "effect/Inspectable";
import * as Layer from "effect/Layer";
import type { Pipeable } from "effect/Pipeable";

export const TypeId = "~alchemy/Construct";

export interface Construct<out A, out E = never, out R = never, out I = never>
  extends Pipeable, Inspectable {
  readonly [TypeId]: Effect.Variance<A, E, R> & {
    readonly Infra: Types.Covariant<I>;
  };
  [Symbol.iterator](): Effect.EffectIterator<Effect.Effect<A, E, R>>;
  [Unify.typeSymbol]?: unknown;
  [Unify.unifySymbol]?: Effect.EffectUnify<this>;
  [Unify.ignoreSymbol]?: {};
}

export declare const gen: {
  <
    Eff extends Effect.Effect<any, any, any>,
    AEff extends Effect.Effect<any, any, any>,
  >(
    body: () => Generator<Eff, AEff, never>,
  ): Construct<
    AEff,
    [Eff | AEff] extends [never]
      ? never
      : [Eff] extends [Effect.Effect<infer _A, infer E, infer _R>]
        ? E
        : never,
    [Eff | AEff] extends [never]
      ? never
      : [Eff] extends [Effect.Effect<infer _A, infer _E, infer R>]
        ? R
        : never
  >;
};

export declare const provide: {
  <const Layers extends [Layer.Any, ...Array<Layer.Any>]>(
    layers: Layers,
    options?:
      | {
          readonly local?: boolean | undefined;
        }
      | undefined,
  ): <A, E, R>(
    self: Construct<A, E, R>,
  ) => Construct<
    A,
    E | Layer.Error<Layers[number]>,
    Layer.Services<Layers[number]> | Exclude<R, Layer.Success<Layers[number]>>
  >;
  <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn>,
    options?:
      | {
          readonly local?: boolean | undefined;
        }
      | undefined,
  ): <A, E, R>(
    self: Construct<A, E, R>,
  ) => Construct<A, E | E2, RIn | Exclude<R, ROut>>;
  <R2>(
    context: Context.Context<R2>,
  ): <A, E, R>(self: Construct<A, E, R>) => Construct<A, E, Exclude<R, R2>>;
  <A, E, R, const Layers extends [Layer.Any, ...Array<Layer.Any>]>(
    self: Construct<A, E, R>,
    layers: Layers,
    options?:
      | {
          readonly local?: boolean | undefined;
        }
      | undefined,
  ): Construct<
    A,
    E | Layer.Error<Layers[number]>,
    Layer.Services<Layers[number]> | Exclude<R, Layer.Success<Layers[number]>>
  >;
  <A, E, R, ROut, E2, RIn>(
    self: Construct<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
    options?:
      | {
          readonly local?: boolean | undefined;
        }
      | undefined,
  ): Construct<A, E | E2, RIn | Exclude<R, ROut>>;
  <A, E, R, R2>(
    self: Construct<A, E, R>,
    context: Context.Context<R2>,
  ): Construct<A, E, Exclude<R, R2>>;
};
