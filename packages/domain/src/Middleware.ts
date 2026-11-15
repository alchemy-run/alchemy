import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";

/**
 * The middleware a Command or View declares, run in list order: the first
 * entry is the outermost and runs first, and what it provides reaches every
 * later entry and the handler (e.g. `[Session, MfaChallenge]` authenticates,
 * then challenges).
 */
export type List = ReadonlyArray<RpcMiddleware.AnyService>;

/** The services a list of middleware provides to what it guards. */
export type Provides<Ms extends List> = Ms[number] extends infer M
  ? M extends RpcMiddleware.AnyService
    ? RpcMiddleware.Provides<M["Identifier"]>
    : never
  : never;

/** The errors a list of middleware can fail a request with. */
export type Errors<Ms extends List> = Ms[number] extends infer M
  ? M extends RpcMiddleware.AnyService
    ? RpcMiddleware.Error<M["Identifier"]>
    : never
  : never;

/** An RPC with a list of middleware applied. */
export type Apply<R extends Rpc.Any, Ms extends List> = Ms extends readonly [
  infer Head extends RpcMiddleware.AnyService,
  ...infer Tail extends List,
]
  ? Apply<Rpc.AddMiddleware<R, Head>, Tail>
  : R;

/**
 * Apply a list of middleware to an RPC so it runs in list order. The RPC
 * server wraps the handler once per middleware in the order they were added,
 * so the last one added is the outermost: add the list in reverse. @internal
 */
export const apply = (rpc: Rpc.Any, middleware: List): Rpc.Any =>
  middleware.reduceRight<Rpc.Any>(
    (current, service) => (current as Rpc.Rpc<string>).middleware(service),
    rpc,
  );
