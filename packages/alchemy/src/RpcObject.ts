import type * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { RuntimeContext } from "./RuntimeContext.ts";

/**
 * Services a returned RPC method may require. Methods run inside the host
 * Worker or Durable Object, which provides both; other services must be
 * resolved by the factory and closed over.
 */
export type RpcObjectServices = Scope | RuntimeContext;

/**
 * An optional `satisfies` constraint for an Effect-native returned RPC object.
 * Methods may use the calling event's Scope and the host's RuntimeContext
 * (binding clients), but must close over other services.
 * Use this as a constraint, not a client annotation: the inferred object retains
 * its exact keys, generic methods, overloads, and typed failures.
 *
 * Automatic validation inspects statically visible return types. TypeScript
 * exposes only the last overload to conditional types, and unconstrained generic
 * results can hide an object's methods. Validate those objects where constructed.
 */
export interface RpcObject {
  readonly [method: string]: (
    ...args: never[]
  ) =>
    | Effect.Effect<unknown, unknown, RpcObjectServices>
    | Stream.Stream<unknown, unknown, RpcObjectServices>;
}

/**
 * A validation-only intersection for a returned object; never transforms Shape.
 * Only objects whose property values are all callable are method-object
 * candidates. Ordinary data objects and native data containers are left alone.
 * Validation follows methods returning further objects, not capabilities embedded
 * in data fields or containers. Structural types cannot identify own properties
 * or prototypes, and opaque generic results can hide the method-only shape.
 */
export type ValidateRpcObject<Shape> =
  false extends ValidReturnedValue<Shape> ? never : unknown;

/**
 * Validate returned objects without changing a platform's root method services.
 * Effect-valued event handlers are not returned RPC object methods.
 *
 * @internal
 */
export type ValidateRpcShape<Shape> =
  false extends ValidRoot<Shape> ? never : unknown;

type IsAny<T> = 0 extends 1 & T ? true : false;

type SeenBefore<Value, Seen> = true extends (
  Seen extends unknown
    ? [Value] extends [Seen]
      ? [Seen] extends [Value]
        ? true
        : false
      : false
    : never
)
  ? true
  : false;

type ValidRoot<Shape> =
  IsAny<Shape> extends true
    ? true
    : Shape extends Effect.Effect<infer Inner, any, any>
      ? ValidRoot<Inner>
      : Shape extends object
        ? ValidRootMember<Shape[keyof Shape]>
        : true;

type ValidRootMember<Member> =
  IsAny<Member> extends true
    ? true
    : Member extends (...args: never[]) => infer Result
      ? Result extends
          | Effect.Effect<infer Value, any, any>
          | Stream.Stream<infer Value, any, any>
        ? ValidReturnedValue<Value>
        : true
      : true;

type ValidReturnedValue<Value, Seen = never> =
  IsAny<Value> extends true
    ? true
    : Value extends
          | readonly unknown[]
          | Date
          | RegExp
          | ArrayBuffer
          | ArrayBufferView
          | ReadonlyMap<unknown, unknown>
          | ReadonlySet<unknown>
          | Error
          | Blob
          | Request
          | Response
          | ReadableStream
          | WritableStream
          | Headers
      ? true
      : Value extends object
        ? [Value[keyof Value]] extends [(...args: never[]) => unknown]
          ? SeenBefore<Value, Seen> extends true
            ? true
            : ValidReturnedMember<Value[keyof Value], Seen | Value>
          : true
        : true;

type ValidReturnedMember<Member, Seen> =
  IsAny<Member> extends true
    ? true
    : Member extends (...args: never[]) => infer Result
      ? ValidMethodResult<Result, Seen>
      : true;

type ValidMethodResult<Result, Seen> =
  IsAny<Result> extends true
    ? true
    : Result extends
          | Effect.Effect<infer Value, any, infer Req>
          | Stream.Stream<infer Value, any, infer Req>
      ? [Req] extends [RpcObjectServices]
        ? ValidReturnedValue<Value, Seen>
        : false
      : false;
