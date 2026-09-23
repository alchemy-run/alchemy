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
  readonly [key: string]: RpcMember;
}

/** An Effect or Stream method callable over RPC. */
export type RpcMethod = (
  ...args: never[]
) =>
  | Effect.Effect<unknown, unknown, RpcObjectServices>
  | Stream.Stream<unknown, unknown, RpcObjectServices>;

/**
 * A member of a returned RPC object: a method, a nested object or array, or
 * data. Data fields are copied when the object is returned.
 */
export type RpcMember =
  | RpcMethod
  | RpcObject
  | ReadonlyArray<RpcMember>
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Exclude<
      RpcLeaf,
      Effect.Effect<any, any, any> | Stream.Stream<any, any, any>
    >;

/**
 * A validation-only intersection for a returned object; never transforms Shape.
 * Validation follows plain data fields and arrays to methods at any depth, and
 * methods returning further objects. Objects made only of methods must contain
 * only Effect or Stream methods. Structural types cannot identify own
 * properties or prototypes, and opaque generic results can hide methods.
 */
export type ValidateRpcObject<Shape, Allowed = RpcObjectServices> =
  false extends ValidReturnedValue<Shape, Allowed> ? never : unknown;

/**
 * Validate returned objects without changing a platform's root method services.
 * Effect-valued event handlers are not returned RPC object methods.
 *
 * @internal
 */
export type ValidateRpcShape<Shape, Allowed = RpcObjectServices> =
  false extends ValidRoot<Shape, Allowed> ? never : unknown;

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

type ValidRoot<Shape, Allowed> =
  IsAny<Shape> extends true
    ? true
    : Shape extends Effect.Effect<infer Inner, any, any>
      ? ValidRoot<Inner, Allowed>
      : Shape extends object
        ? ValidRootMember<Shape[keyof Shape], Allowed>
        : true;

type ValidRootMember<Member, Allowed> =
  IsAny<Member> extends true
    ? true
    : Member extends (...args: never[]) => infer Result
      ? Result extends
          | Effect.Effect<infer Value, any, any>
          | Stream.Stream<infer Value, any, any>
        ? ValidReturnedValue<Value, Allowed>
        : true
      : true;

type RpcLeaf =
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
  | Effect.Effect<any, any, any>
  | Stream.Stream<any, any, any>;

type AnyFunction = (...args: never[]) => unknown;

/** String keys that hold fields; `~`-prefixed keys are Effect type ids. */
type FieldKeys<T> = Exclude<Extract<keyof T, string>, `~${string}`>;

/**
 * Objects made only of methods keep the strict rule: every member must be an
 * Effect or Stream method. Objects that mix data and methods are walked
 * through their string-keyed fields, where Effect and Stream methods are
 * checked and data values are followed.
 */
type ValidReturnedValue<Value, Allowed, Seen = never> =
  IsAny<Value> extends true
    ? true
    : Value extends RpcLeaf
      ? true
      : Value extends object
        ? SeenBefore<Value, Seen> extends true
          ? true
          : Value extends readonly (infer Element)[]
            ? ValidDataMember<Element, Allowed, Seen | Value>
            : [Value[FieldKeys<Value>]] extends [AnyFunction]
              ? ValidReturnedMember<
                  Value[FieldKeys<Value>],
                  Allowed,
                  Seen | Value
                >
              : ValidDataMember<Value[FieldKeys<Value>], Allowed, Seen | Value>
        : true;

type ValidReturnedMember<Member, Allowed, Seen> =
  IsAny<Member> extends true
    ? true
    : Member extends (...args: never[]) => infer Result
      ? ValidMethodResult<Result, Allowed, Seen>
      : true;

type ValidDataMember<Member, Allowed, Seen> =
  IsAny<Member> extends true
    ? true
    : Member extends (...args: never[]) => infer Result
      ? Result extends
          | Effect.Effect<any, any, any>
          | Stream.Stream<any, any, any>
        ? ValidMethodResult<Result, Allowed, Seen>
        : true
      : ValidReturnedValue<Member, Allowed, Seen>;

type ValidMethodResult<Result, Allowed, Seen> =
  IsAny<Result> extends true
    ? true
    : Result extends
          | Effect.Effect<infer Value, any, infer Req>
          | Stream.Stream<infer Value, any, infer Req>
      ? [Req] extends [Allowed]
        ? ValidReturnedValue<Value, Allowed, Seen>
        : false
      : false;
