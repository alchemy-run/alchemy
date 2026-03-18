import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";
import type { Output } from "./Output.ts";
import type { ResourceLike } from "./Resource.ts";

export class Self extends ServiceMap.Service<Self, ResourceLike>()(
  "Alchemy::Self",
) {}

export interface BaseExecutionContext {
  type: string;
  id: string;
  env: Record<string, any>;
  get<T>(key: string): Effect.Effect<T>;
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Record<string, any>;
}

export class ExecutionContext extends ServiceMap.Service<
  ExecutionContext,
  BaseExecutionContext
>()("Alchemy::ExecutionContext") {}

export const CurrentExecutionContext = Effect.serviceOption(
  ExecutionContext,
).pipe(Effect.map(Option.getOrUndefined));
