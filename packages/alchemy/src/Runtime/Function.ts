import * as Effect from "effect/Effect";
import type { HttpEffect } from "../Http.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";

type AnyFunctionListener = (event: any) => Effect.Effect<any, any, any> | void;

/**
 * Requirements of the effect a listener returns.
 *
 * `void` and `undefined` decline the event. The listener function is inferred
 * whole, and the requirements are read off its return type: a `Req` nested
 * inside `Effect | undefined` is not an inference site, so a default of
 * `never` would reject every handler that closes over a service.
 */
export type ListenerRequirements<L extends AnyFunctionListener> = [
  Exclude<ReturnType<L>, void | undefined>,
] extends [never]
  ? never
  : Exclude<ReturnType<L>, void | undefined> extends Effect.Effect<any, any, infer R>
    ? R
    : never;

/**
 * Runtime context for registering handlers on a serverless function.
 *
 * @typeParam InitProvided Services the host supplies while a deferred
 * listener initializes, once per instance.
 * @typeParam InvocationProvided Services the host supplies each time a
 * listener handles an invocation.
 */
export interface FunctionContext<
  InitProvided = never,
  InvocationProvided = never,
> extends BaseRuntimeContext {
  /**
   * Register an HTTP handler. The optional `shape` payload is the user's
   * full default-export shape — Cloudflare Workers use it to expose
   * non-handler methods (e.g. `greet`) as RPC methods on the deployed
   * `WorkerEntrypoint`. Other platforms (Lambda, etc.) ignore it.
   */
  serve<Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ): Effect.Effect<void, never, Exclude<Req, InvocationProvided>>;
  listen<A, Req = never>(
    handler: FunctionListener<A, Req>,
  ): Effect.Effect<void, never, Exclude<Req, InvocationProvided>>;
  listen<A, Req = never, InitReq = never>(
    effect: Effect.Effect<FunctionListener<A, Req>, never, InitReq>,
  ): Effect.Effect<void, never, Exclude<InitReq, InitProvided> | Exclude<Req, InvocationProvided>>;
  listen<L extends AnyFunctionListener>(
    handler: L,
  ): Effect.Effect<void, never, Exclude<ListenerRequirements<L>, InvocationProvided>>;
  listen<L extends AnyFunctionListener, InitReq = never>(
    effect: Effect.Effect<L, never, InitReq>,
  ): Effect.Effect<
    void,
    never,
    Exclude<InitReq, InitProvided> | Exclude<ListenerRequirements<L>, InvocationProvided>
  >;
  exports: Effect.Effect<Record<string, any>, never, never>;
}

export type FunctionListener<A = any, Req = never> = (
  event: any,
) => Effect.Effect<A, never, Req> | void;
