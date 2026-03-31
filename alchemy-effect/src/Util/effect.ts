import * as Effect from "effect/Effect";
import { pipeArguments } from "effect/Pipeable";
import * as ServiceMap from "effect/ServiceMap";
import { SingleShotGen } from "effect/Utils";

export type EffectClass<Shape, A, Err = never, Req = never> = Effect.Effect<
  A,
  Err,
  Req
> & {
  new (_: never): Shape;
};

export const effectClass: {
  <A, Err = never, Req = never>(
    impl: Effect.Effect<A, Err, Req>,
  ): EffectClass<A, A, Err, Req>;
  <Shape>(): <A, Err = never, Req = never>(
    impl: Effect.Effect<A, Err, Req>,
  ) => EffectClass<Shape, A, Err, Req>;
} = ((impl?: any) =>
  impl === undefined
    ? (innerImpl: any) => effectClass(innerImpl)
    : (Object.assign(
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
      ) as unknown as EffectClass<any, any, any, any>)) as any;

export const taggedFunction = <
  Tag extends ServiceMap.ServiceClass<any, any, any>,
  Fn extends (...args: any[]) => any,
>(
  tag: Tag,
  fn: Fn,
): Tag & Fn =>
  Object.assign(fn, tag, {
    asEffect() {
      return tag.asEffect();
    },
    [Symbol.iterator]() {
      return tag[Symbol.iterator]();
    },
    pipe() {
      return pipeArguments(tag.asEffect(), arguments);
    },
    toString: () => `${tag.toString()}.${fn.name}`,
  });
