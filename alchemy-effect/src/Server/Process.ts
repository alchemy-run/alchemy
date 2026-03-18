import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { PolicyLike } from "../Binding.ts";
import { ExecutionContext } from "../ExecutionContext.ts";
import type { Input } from "../Input.ts";
import type { Provider } from "../Provider.ts";
import {
  Resource,
  type ResourceLike,
  type ResourceProviders,
} from "../Resource.ts";
import { Stack, type StackServices } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import {
  ServerContext,
  type ServerExecutionContext,
} from "./ExecutionContext.ts";

export type ExecutableServices =
  | Provider<any>
  | PolicyLike
  | Stack
  | Stage
  | Scope
  | StackServices;

export type RuntimePlatformServices = ExecutionContext | HttpClient | Scope;

export type ProcessConstructor<Self extends ResourceLike, RuntimeServices> = {
  Props: Self["Props"];
  <Req extends ExecutableServices | RuntimeServices = never>(
    id: string,
    eff: Self["Props"],
  ): Effect.Effect<
    Self,
    never,
    Provider<Self> | Exclude<Req, RuntimeServices | RuntimePlatformServices>
  >;

  (
    id: string,
  ): <
    Req extends
      | ExecutableServices
      | RuntimeServices
      | RuntimePlatformServices
      | HttpClient = never,
  >(
    eff: Effect.Effect<Input<Self["Props"]>, never, Req>,
  ) => Effect.Effect<
    Self,
    never,
    Provider<Self> | Exclude<Req, RuntimeServices | RuntimePlatformServices>
  >;
};

export type ProcessClass<
  Self extends ResourceLike,
  Runtime extends ServerExecutionContext,
  Services,
> = ProcessConstructor<Self, Services> &
  Effect.Effect<ProcessConstructor<Self, Services>> & {
    provider: ResourceProviders<Self>;
    Runtime: ServiceMap.Service<Self, Runtime>;
  };

export type ProcessEffect<Req = never> = Effect.Effect<void, never, Req>;

export const Process =
  <
    Self extends ResourceLike<
      string,
      | {
          env?: Record<string, any>;
          exports?: string[];
        }
      | undefined
    >,
    Services = never,
  >(
    type: Self["Type"],
  ) =>
  <Runtime extends ServerExecutionContext>(
    createExecutionContext: (id: string) => Runtime,
  ): ProcessClass<Self, Runtime, Services | RuntimePlatformServices> => {
    type PropsShape =
      | {
          [prop in keyof Exclude<Self["Props"], undefined>]: Input<
            Exclude<Self["Props"], undefined>[prop]
          >;
        }
      | undefined;
    type Props =
      | PropsShape
      | Effect.Effect<PropsShape, never, Services | Runtime>;
    type Impl = Effect.Effect<
      ProcessEffect<Services | Runtime>,
      never,
      Services | Runtime
    >;

    const resource = Resource(type);
    const host = ServiceMap.Service<Self, Runtime>(`Host<${type}>`);
    const constructor = (id: string, props?: Props) => (impl: Impl) =>
      Effect.flatMap(
        Effect.all([
          Effect.isEffect(props)
            ? props
            : Effect.succeed(props ?? ({} as PropsShape)),
          Effect.sync(() => createExecutionContext(id)),
          Effect.services<never>(),
        ]),
        ([props, executionContext, services]) =>
          resource(
            id,
            // @ts-expect-error
            impl.pipe(
              Effect.flatMap((processEffect) =>
                Effect.andThen(executionContext.run(processEffect), () =>
                  Effect.succeed({
                    ...props,
                    env: {
                      ...props?.env,
                      ...executionContext.env,
                    },
                  }),
                ),
              ),
              Effect.provide(
                pipe(
                  Layer.succeed(ExecutionContext, executionContext),
                  Layer.provideMerge(
                    Layer.succeed(ServerContext, executionContext),
                  ),
                  Layer.provideMerge(Layer.succeed(host, executionContext)),
                  Layer.provideMerge(Layer.succeedServices(services)),
                ),
              ),
            ),
          ).pipe(
            Effect.map(
              (resource) =>
                Object.assign(resource, {
                  ExecutionContext: executionContext,
                }) as Self,
            ),
          ),
      );

    return Object.assign(constructor, resource, {
      Runtime: host,
    }) as any;
  };
