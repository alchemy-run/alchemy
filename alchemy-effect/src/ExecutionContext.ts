import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";
import type { Output } from "./Output.ts";
import { GenericService } from "./Util/service.ts";

export interface BaseExecutionContext {
  Type: string;
  id: string;
  env: Record<string, any>;
  get<T>(key: string): Effect.Effect<T>;
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Record<string, any>;
}

export interface ExecutionContext<
  Ctx extends BaseExecutionContext = BaseExecutionContext,
> extends ServiceMap.Service<`ExecutionContext<${Ctx["Type"]}>`, Ctx> {}

export const ExecutionContext = GenericService<{
  <Ctx extends BaseExecutionContext>(type: Ctx["Type"]): ExecutionContext<Ctx>;
}>()("Alchemy::ExecutionContext");

export const CurrentExecutionContext = Effect.serviceOption(
  ExecutionContext,
).pipe(Effect.map(Option.getOrUndefined));
