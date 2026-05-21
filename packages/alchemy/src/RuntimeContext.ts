import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { HttpEffect } from "./Http.ts";
import type { Output } from "./Output.ts";

export interface BaseRuntimeContext {
  Type: string;
  id: string;
  env: Record<string, any>;
  get<T>(key: string): Effect.Effect<T>;
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Effect.Effect<Record<string, any>>;
  serve?<Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ): Effect.Effect<void, never, Req>;
  shape?: () => Record<string, unknown>;
  /** additional services to provide to the plan  */
  planServices?: Layer.Layer<any>;
}

/**
 * Context of the runtime environment.
 *
 * E.g. the context of a running Worker, Task, Process, Function
 */
export class RuntimeContext extends Context.Service<
  RuntimeContext,
  BaseRuntimeContext
>()("RuntimeContext") {}

export const CurrentRuntimeContext = Effect.serviceOption(RuntimeContext).pipe(
  Effect.map(Option.getOrUndefined),
);
