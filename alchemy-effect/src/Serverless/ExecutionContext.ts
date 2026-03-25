import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type { BaseExecutionContext } from "../ExecutionContext.ts";
import type { HttpEffect } from "../Http.ts";

export type Listener<A = any, Req = never> = (
  event: any,
) => Effect.Effect<A, never, Req> | void;

export interface ExecutionContext extends BaseExecutionContext {
  serve<Req = never>(handler: HttpEffect<Req>): Effect.Effect<void, never, Req>;
  listen<A, Req = never>(
    handler: Listener<A, Req>,
  ): Effect.Effect<void, never, Req>;
  listen<A, Req = never, InitReq = never>(
    effect: Effect.Effect<Listener<A, Req>, never, InitReq>,
  ): Effect.Effect<void, never, Req | InitReq>;
  exports: Record<string, any>;
}

export class Context extends ServiceMap.Service<Context, ExecutionContext>()(
  "Alchemy::ServerlessExecutionContext",
) {}
