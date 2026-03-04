import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { PolicyLike } from "./Binding.ts";
import type { Provider } from "./Provider.ts";
import {
  Resource,
  type ResourceLike,
  type ResourceProviders,
} from "./Resource.ts";
import type { Stack, StackServices } from "./Stack.ts";
import type { Stage } from "./Stage.ts";

export type HostServices =
  | Provider<any>
  | PolicyLike
  | Stack
  | Stage
  | Scope
  | ExecutionContext
  | StackServices;

export type HostConstructor<R extends ResourceLike, RuntimeServices> = {
  <Req extends HostServices | RuntimeServices = never>(
    id: string,
    eff: Effect.Effect<R["Props"], never, Req>,
  ): Effect.Effect<R, never, Exclude<Req, RuntimeServices | ExecutionContext>>;
  (
    id: string,
  ): <Req extends HostServices | RuntimeServices = never>(
    eff: Effect.Effect<R["Props"], never, Req>,
  ) => Effect.Effect<
    R,
    never,
    Exclude<Req, RuntimeServices | ExecutionContext>
  >;
};

export type HostClass<Self extends ResourceLike, Provided> = HostConstructor<
  Self,
  Provided
> &
  Effect.Effect<HostConstructor<Self, Provided>> & {
    kind: "Executable";
    provider: ResourceProviders<Self>;
    self: ServiceMap.Service<Self, Self>;
  };

export const Host = <R extends ResourceLike, Provided>(
  type: R["Type"],
): HostClass<R, Provided> => Resource(type) as any as HostClass<R, Provided>;

export class ExecutionContext extends ServiceMap.Service<
  ExecutionContext,
  FunctionExecutionContext | ProcessExecutionContext
>()("Alchemy::ExecutionContext") {}

interface BaseExecutionContext<Type extends string = string> {
  LogicalId: string;
  Type: Type;
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

export interface ProcessExecutionContext<
  Type extends string = string,
> extends BaseExecutionContext<Type> {
  listen?: never;
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}
