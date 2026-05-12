import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpEffect } from "./Http.ts";
import type { Output } from "./Output.ts";
import { GenericService } from "./Util/service.ts";

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
}

export interface RuntimeContext<
  Ctx extends BaseRuntimeContext = BaseRuntimeContext,
> extends Context.Service<`RuntimeContext<${Ctx["Type"]}>`, Ctx> {}

/**
 * Context of the runtime environment.
 *
 * E.g. the context of a running Worker, Task, Process, Function
 */
export const RuntimeContext = GenericService<{
  <Ctx extends BaseRuntimeContext>(type: Ctx["Type"]): RuntimeContext<Ctx>;
}>()("Alchemy::RuntimeContext");

export const CurrentRuntimeContext = Effect.serviceOption(RuntimeContext).pipe(
  Effect.map(Option.getOrUndefined),
);
