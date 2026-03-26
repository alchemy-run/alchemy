import { Platform } from "../Platform.ts";

import * as Effect from "effect/Effect";
import type { BaseExecutionContext } from "../ExecutionContext.ts";
import type { HttpEffect } from "../Http.ts";

export interface Function extends Platform.Class<Function, FunctionContext> {}

export const Function = Platform<Function>();

export interface FunctionContext extends BaseExecutionContext {
  serve<Req = never>(handler: HttpEffect<Req>): Effect.Effect<void, never, Req>;
  listen<A, Req = never>(
    handler: FunctionListener<A, Req>,
  ): Effect.Effect<void, never, Req>;
  listen<A, Req = never, InitReq = never>(
    effect: Effect.Effect<FunctionListener<A, Req>, never, InitReq>,
  ): Effect.Effect<void, never, Req | InitReq>;
  exports: Record<string, any>;
}

export type FunctionListener<A = any, Req = never> = (
  event: any,
) => Effect.Effect<A, never, Req> | void;
