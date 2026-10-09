import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rpc from "effect/rpc/Rpc";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { Fields } from "./Event.ts";

/**
 * The kinds of public operation an Api exposes.
 */
export type Kind = "Mutation" | "Query" | "Subscription";

/** The schema of an operation's output. */
export type OutputSchema<O> = O extends Schema.Top
  ? O
  : O extends Fields
    ? Schema.Struct<O>
    : typeof Schema.Void;

/** The schema of an operation's errors. */
export type ErrorSchema<Errors extends ReadonlyArray<Schema.Top>> = Errors extends readonly []
  ? typeof Schema.Never
  : Schema.Union<Errors>;

/**
 * The implementation of an operation. Mutations and queries return an Effect;
 * subscriptions return an Effect that builds the Stream (and can fail first,
 * e.g. on authorization).
 *
 * `R` is what the operation's middleware provides per request (for example
 * the signed-in principal). Everything else is resolved while building the
 * handler, in `toLayer`.
 */
export type Handler<K extends Kind, I, O, E, R = never> = K extends "Subscription"
  ? (input: I) => Effect.Effect<Stream.Stream<O, E, R>, E, R>
  : (input: I) => Effect.Effect<O, E, R>;

/** The middleware applied to an RPC. */
type MiddlewareOf<R> =
  R extends Rpc.Rpc<infer _T, infer _P, infer _S, infer _E, infer M, infer _R> ? M : never;

/** The services an RPC's middleware provides to its handler. */
export type Provided<R> = ProvidedBy<MiddlewareOf<R>>;
type ProvidedBy<M> = M extends RpcMiddleware.AnyService
  ? RpcMiddleware.Provides<M["Identifier"]>
  : never;

/**
 * Type-level identity of an operation in an Effect's requirements.
 */
export interface OperationKey<Name extends string> {
  readonly "~alchemy/Fold/Operation": Name;
}

/**
 * Structural constraint satisfied by every operation class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: Kind;
  readonly operationName: string;
  readonly rpc: Rpc.Any;
}

/** The requirement identifier of an operation class. */
export type Identifier<O extends Any> = O extends Context.Key<infer I, unknown> ? I : never;

/**
 * The class type returned by an operation builder.
 */
export interface OperationClass<
  K extends Kind,
  Name extends string,
  R extends Rpc.Any,
  I,
  O,
  E,
> extends Context.ServiceClass<OperationKey<Name>, string, Handler<K, I, O, E, Provided<R>>> {
  readonly kind: K;
  readonly operationName: Name;
  /** The underlying Effect RPC definition. */
  readonly rpc: R;
  /**
   * Apply an `RpcMiddleware`. Whatever it provides (e.g. the signed-in
   * principal) becomes available to this operation's handler per request.
   */
  middleware<M extends RpcMiddleware.AnyService>(
    middleware: M,
  ): OperationClass<K, Name, Rpc.AddMiddleware<R, M>, I, O, E>;
  /**
   * Implement the operation. The construction Effect runs once and resolves
   * every service the handler uses (aggregate clients, views, feeds); the
   * handler may only require what this operation's middleware provides.
   */
  toLayer<EB, RB>(
    build: Effect.Effect<Handler<K, I, O, E, Provided<R>>, EB, RB>,
  ): Layer.Layer<OperationKey<Name>, EB, RB>;
}

/**
 * Options shared by every operation builder.
 */
export interface Options<I extends Fields, O, Errors extends ReadonlyArray<Schema.Top>> {
  /** The operation's input fields. */
  readonly input?: I;
  /** The operation's output: a field map or a schema. */
  readonly output?: O;
  /** The public error contract: rejections and other errors callers may handle. */
  readonly errors?: Errors;
}

type MakeRpc<
  K extends Kind,
  Name extends string,
  I extends Fields,
  O,
  Errors extends ReadonlyArray<Schema.Top>,
> = Rpc.Rpc<
  Name,
  Schema.Struct<I>,
  K extends "Subscription"
    ? import("effect/rpc/RpcSchema").Stream<OutputSchema<O>, ErrorSchema<Errors>>
    : OutputSchema<O>,
  K extends "Subscription" ? typeof Schema.Never : ErrorSchema<Errors>
>;

/** @internal */
export const make =
  <K extends Kind>(kind: K) =>
  <
    const Name extends string,
    const I extends Fields = {},
    O extends Fields | Schema.Top | undefined = undefined,
    const Errors extends ReadonlyArray<Schema.Top> = readonly [],
  >(
    name: Name,
    options: Options<I, O, Errors> = {},
  ): OperationClass<
    K,
    Name,
    MakeRpc<K, Name, I, O, Errors>,
    Schema.Struct<I>["Type"],
    OutputSchema<O>["Type"],
    ErrorSchema<Errors>["Type"]
  > => {
    const output =
      options.output === undefined
        ? Schema.Void
        : "ast" in (options.output as object)
          ? (options.output as Schema.Top)
          : Schema.Struct(options.output as Fields);
    const errors = options.errors ?? [];
    const error =
      errors.length === 0 ? Schema.Never : Schema.Union(errors as ReadonlyArray<Schema.Top>);
    const rpc = Rpc.make(name, {
      payload: options.input ?? {},
      success: output,
      error,
      stream: kind === "Subscription",
    });
    return build(kind, name, rpc) as unknown as OperationClass<
      K,
      Name,
      MakeRpc<K, Name, I, O, Errors>,
      Schema.Struct<I>["Type"],
      OutputSchema<O>["Type"],
      ErrorSchema<Errors>["Type"]
    >;
  };

/** The untyped handler the framework calls. @internal */
export type HandlerImpl = (input: unknown) => Effect.Effect<unknown, unknown>;

const build = (kind: Kind, name: string, rpc: Rpc.Any) => {
  const Tag = Context.Service<OperationKey<string>, HandlerImpl>()(
    `alchemy/Fold/Operation/${name}`,
  );
  return class extends Tag {
    static readonly kind = kind;
    static readonly operationName = name;
    static readonly rpc = rpc;
    static middleware(middleware: RpcMiddleware.AnyService): ReturnType<typeof build> {
      return build(kind, name, (rpc as Rpc.Rpc<string>).middleware(middleware));
    }
    static toLayer<EB, RB>(builder: Effect.Effect<HandlerImpl, EB, RB>) {
      return Layer.effect(Tag, builder);
    }
  };
};
