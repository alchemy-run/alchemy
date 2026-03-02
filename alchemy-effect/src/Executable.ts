import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type { PolicyLike } from "./Binding.ts";
import type { Provider } from "./Provider.ts";
import {
  Resource,
  type ResourceLike,
  type ResourceProviders,
} from "./Resource.ts";
import type { Stack } from "./Stack.ts";
import type { Stage } from "./Stage.ts";

type ExecutableServices = Provider<any> | PolicyLike | Stack | Stage;

export type ExecutableConstructor<R extends ResourceLike, Provided> = {
  <Req = never>(
    id: string,
    eff: Effect.Effect<R["Props"], never, Req | ExecutableServices>,
  ): Effect.Effect<R, never, Exclude<Req, Provided | ExecutionContextLike>>;
  <Req = never>(
    id: string,
  ): (
    eff: Effect.Effect<R["Props"], never, Req | ExecutableServices>,
  ) => Effect.Effect<R, never, Exclude<Req, Provided | ExecutionContextLike>>;
};

export type ExecutableClass<
  Self extends ResourceLike,
  Provided,
> = ExecutableConstructor<Self, Provided> &
  Effect.Effect<ExecutableConstructor<Self, Provided>> & {
    kind: "Executable";
    provider: ResourceProviders<Self>;
    ExecutionContext: ServiceMap.Service<Self, Self>;
  };

export const Executable = <R extends ResourceLike, Provided>(
  type: R["Type"],
): ExecutableClass<R, Provided> =>
  Resource(type) as any as ExecutableClass<R, Provided>;

export class ExecutionContext extends ServiceMap.Service<
  ExecutionContext,
  FunctionExecutionContext | DaemonExecutionContext
>()("Alchemy::ExecutionContext") {}

export type ExecutionContextLike = { kind: "ExecutionContext" };

interface BaseExecutionContext<
  Type extends string = string,
> extends ExecutionContextLike {
  type: Type;
  /**
   * Get a value from the Runtime
   */
  get<T>(key: string): Effect.Effect<T>;
}

export interface FunctionExecutionContext<
  Type extends string = string,
> extends BaseExecutionContext<Type> {
  listen<A, Req = never>(
    handler: (event: any) => Effect.Effect<A, never, Req> | void,
  ): Effect.Effect<A, never, Req>;
  listen<A, Req = never, InitReq = never>(
    effect: Effect.Effect<
      (event: any) => Effect.Effect<A, never, Req> | void,
      never,
      InitReq
    >,
  ): Effect.Effect<A, never, Req | InitReq>;
  run?: never;
}

export interface DaemonExecutionContext<
  Type extends string = string,
> extends BaseExecutionContext<Type> {
  listen?: never;
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}
