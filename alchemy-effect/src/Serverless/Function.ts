import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { PolicyLike } from "../Binding.ts";
import {
  ExecutionContext,
  type BaseExecutionContext,
} from "../ExecutionContext.ts";
import * as Http from "../Http.ts";
import type { Input } from "../Input.ts";
import type { Provider } from "../Provider.ts";
import {
  Resource,
  type ResourceLike,
  type ResourceProviders,
} from "../Resource.ts";
import type { Stack, StackServices } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import * as Serverless from "./ExecutionContext.ts";

// services provided to the Resource
type FunctionServices =
  | Provider<any>
  | PolicyLike
  | Stack
  | Stage
  | Scope
  | StackServices;

// services provided at runtime
type RuntimeServices =
  | ExecutionContext
  | Serverless.Context
  | HttpClient
  | Scope;

export type FunctionConstructor<
  Self extends ResourceLike,
  ProvidedServices = never,
> = {
  Props: Self["Props"];
  <Req = never>(
    id: string,
    ...props: undefined extends Self["Props"]
      ? [
          props?:
            | {
                [prop in keyof Self["Props"]]: Input<Self["Props"][prop]>;
              }
            | Effect.Effect<
                {
                  [prop in keyof Self["Props"]]: Input<Self["Props"][prop]>;
                },
                never,
                Req
              >,
        ]
      : [
          props:
            | {
                [prop in keyof Self["Props"]]: Input<Self["Props"][prop]>;
              }
            | Effect.Effect<
                {
                  [prop in keyof Self["Props"]]: Input<Self["Props"][prop]>;
                },
                never,
                Req
              >,
        ]
  ): <Req extends FunctionServices | ProvidedServices = never>(
    impl: Effect.Effect<Http.HttpEffect, never, Req>,
  ) => Effect.Effect<
    Self,
    never,
    Provider<Self> | Exclude<Req, RuntimeServices | ProvidedServices | Self>
  >;

  asEffect(): Effect.Effect<Self, never, Provider<Self>>;

  [Symbol.iterator](): Effect.Yieldable<
    Effect.Effect<Self, never, Provider<Self>>,
    Self,
    never,
    Provider<Self>
  >;
};

export type FunctionClass<
  Self extends ResourceLike,
  Runtime extends BaseExecutionContext,
  Services,
> = FunctionConstructor<Self, Services> &
  Effect.Effect<FunctionConstructor<Self, Services>> & {
    provider: ResourceProviders<Self>;
    Runtime: ServiceMap.Service<Self, Runtime>;
  };

export const Function =
  <
    R extends ResourceLike<
      string,
      | {
          env?: Record<string, any>;
          exports?: string[];
        }
      | undefined
    >,
    Services = never,
  >(
    type: R["Type"],
  ) =>
  <Runtime extends Serverless.ExecutionContext>(
    createExecutionContext: (id: string) => Runtime,
  ): FunctionClass<R, Runtime, Services | RuntimeServices> => {
    type PropsShape =
      | {
          [prop in keyof Exclude<R["Props"], undefined>]: Input<
            Exclude<R["Props"], undefined>[prop]
          >;
        }
      | undefined;
    type Props =
      | PropsShape
      | Effect.Effect<PropsShape, never, Services | Runtime>;
    type Impl = Effect.Effect<Http.HttpEffect, never, Services | Runtime>;

    const resource = Resource(type);
    const host = ServiceMap.Service<R, Runtime>(`Host<${type}>`);
    const constructor = (id: string, props?: Props) => (impl: Impl) =>
      Effect.flatMap(
        Effect.all([
          Effect.isEffect(props)
            ? props
            : Effect.succeed(props ?? ({} as PropsShape)),
          Effect.sync(() => createExecutionContext(id)),
          Effect.services<never>(),
        ]),
        ([props, executionContext, outerServices]) =>
          resource(
            id,
            // @ts-expect-error
            impl.pipe(
              Effect.flatMap((httpEffect) =>
                Effect.andThen(Http.serve(httpEffect), () =>
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
                Layer.provideMerge(
                  Layer.mergeAll(
                    Layer.succeed(host, executionContext),
                    Layer.succeed(ExecutionContext, executionContext),
                    Layer.succeed(Serverless.Context, executionContext),
                  ),
                  Layer.succeedServices(outerServices),
                ),
              ),
            ),
          ).pipe(
            Effect.map(
              (resource) =>
                Object.assign(resource, {
                  ExecutionContext: executionContext,
                }) as R,
            ),
          ),
      );

    return Object.assign(constructor, resource, {
      Runtime: host,
    }) as any;
  };
