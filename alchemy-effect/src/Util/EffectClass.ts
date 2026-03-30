import * as Effect from "effect/Effect";
import { pipeArguments } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";

export type EffectClass<Shape, A, Err = never, Req = never> = Effect.Effect<
  A,
  Err,
  Req
> & {
  new (_: never): Shape;
};

export const effectClass =
  <Shape>() =>
  <A, Err = never, Req = never>(
    impl: Effect.Effect<A, Err, Req>,
  ): EffectClass<Shape, A, Err, Req> =>
    Object.assign(
      class {
        static asEffect() {
          return impl;
        }
        static [Symbol.iterator]() {
          return new SingleShotGen(this);
        }
        static pipe(...fns: any) {
          return pipeArguments(this.asEffect(), fns);
        }
      },
      impl,
    ) as unknown as EffectClass<Shape, A, Err, Req>;
