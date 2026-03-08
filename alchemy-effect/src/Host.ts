import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
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
  | StackServices;

export type HostRuntimeServices = ExecutionContext | HttpClient | Scope;

export type HostConstructor<Self extends ResourceLike, RuntimeServices> = {
  <Req extends HostServices | RuntimeServices = never>(
    id: string,
    eff: Self["Props"],
  ): Effect.Effect<
    Self,
    never,
    Provider<Self> | Exclude<Req, RuntimeServices | HostRuntimeServices>
  >;
  <Req extends HostServices | RuntimeServices = never>(
    id: string,
    eff: Effect.Effect<Self["Props"], never, Req>,
  ): Effect.Effect<
    Self,
    never,
    Provider<Self> | Exclude<Req, RuntimeServices | HostRuntimeServices>
  >;

  (
    id: string,
  ): <
    Req extends
      | HostServices
      | RuntimeServices
      | HostRuntimeServices
      | HttpClient = never,
  >(
    eff: Effect.Effect<Self["Props"], never, Req>,
  ) => Effect.Effect<
    Self,
    never,
    Provider<Self> | Exclude<Req, RuntimeServices | HostRuntimeServices>
  >;
};

export interface Host<Self = any> {
  self: Self;
}

export type HostClass<
  Self extends ResourceLike,
  Runtime extends ExecutionContextService,
  Services,
> = HostConstructor<Self, Services | Host> &
  Effect.Effect<HostConstructor<Self, Services>> & {
    kind: "Executable";
    provider: ResourceProviders<Self>;
    Runtime: ServiceMap.Service<Host<Self>, Runtime>;
  };

export const Host = <
  R extends ResourceLike,
  Runtime extends ExecutionContextService,
  Services = never,
>(
  type: R["Type"],
  runtime: (id: string) => Effect.Effect<Runtime>,
): HostClass<R, Runtime, Services | HostRuntimeServices> => {
  type Eff = Effect.Effect<R["Props"], never, Services | Runtime>;

  const resource = Resource(type);
  const host = ServiceMap.Service<Host<R>, Runtime>(`Host<${type}>`);
  const constructor = (id: string, eff?: Eff) =>
    eff
      ? runtime(id).pipe(
          // Effect.map((executionContext) => ({
          //   LogicalId: id,
          //   ...executionContext,
          // })),
          Effect.flatMap((executionContext) =>
            resource(
              id,
              eff.pipe(
                Effect.provideService(ExecutionContext, executionContext),
                Effect.provideService(host, executionContext),
              ),
            ),
          ),
        )
      : (eff: Eff) => constructor(id, eff);
  return Object.assign(constructor, resource, {
    Runtime: host,
  }) as any;
};

export class Self extends ServiceMap.Service<Self, ResourceLike>()(
  "Alchemy::Self",
) {}

export class ExecutionContext extends ServiceMap.Service<
  ExecutionContext,
  ServerlessExecutionContext | ServerExecutionContext
>()("Alchemy::ExecutionContext") {}

export type ExecutionContextService =
  | ServerlessExecutionContext
  | ServerExecutionContext;

interface BaseExecutionContext {
  type: string;
  id: string;
  /**
   * Get a value from the Runtime
   */
  get<T>(key: string): Effect.Effect<T>;
}

export type ListenHandler<A = any, Req = never> = (
  event: any,
) => Effect.Effect<A, never, Req> | void;

export interface ServerlessExecutionContext extends BaseExecutionContext {
  listen<A, Req = never>(
    handler: ListenHandler<A, Req>,
  ): Effect.Effect<void, never, Req>;
  listen<A, Req = never, InitReq = never>(
    effect: Effect.Effect<ListenHandler<A, Req>, never, InitReq>,
  ): Effect.Effect<void, never, Req | InitReq>;
  exports: Record<string, any>;
  run?: never;
}

export interface ServerExecutionContext extends BaseExecutionContext {
  listen?: never;
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}
