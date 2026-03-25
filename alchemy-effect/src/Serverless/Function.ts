import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { SingleShotGen } from "effect/Utils";
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
import { Self } from "../Self.ts";
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
  Resource extends ResourceLike,
  ProvidedServices = never,
> = {
  Props: Resource["Props"];
  <Self>(): <const Id extends string, Req = never>(
    id: Id,
    ...props: undefined extends Resource["Props"]
      ? [
          props?:
            | {
                [prop in keyof Resource["Props"]]: Input<
                  Resource["Props"][prop]
                >;
              }
            | Effect.Effect<
                {
                  [prop in keyof Resource["Props"]]: Input<
                    Resource["Props"][prop]
                  >;
                },
                never,
                Req
              >,
        ]
      : [
          props:
            | {
                [prop in keyof Resource["Props"]]: Input<
                  Resource["Props"][prop]
                >;
              }
            | Effect.Effect<
                {
                  [prop in keyof Resource["Props"]]: Input<
                    Resource["Props"][prop]
                  >;
                },
                never,
                Req
              >,
        ]
  ) => Effect.Effect<Resource, never, Provider<Resource> | Self> & {
    new (_: never): {
      LogicalId: Id;
    };
    make<
      Req extends FunctionServices | ProvidedServices | Self | Resource = never,
    >(
      impl: Effect.Effect<Http.HttpEffect | void, never, Req>,
    ): Layer.Layer<
      Self,
      never,
      | Provider<Resource>
      | Exclude<Req, RuntimeServices | ProvidedServices | Resource | Self>
    >;
  };

  asEffect(): Effect.Effect<Resource, never, Provider<Resource>>;

  [Symbol.iterator](): Effect.Yieldable<
    Effect.Effect<Resource, never, Provider<Resource>>,
    Resource,
    never,
    Provider<Resource>
  >;
};

export type FunctionClass<
  Self extends ResourceLike,
  Runtime extends BaseExecutionContext,
  Services,
> = FunctionConstructor<Self, Services> &
  Effect.Effect<FunctionConstructor<Self, Services>> & {
    provider: ResourceProviders<Self>;
    Self: ServiceMap.Service<Self, Self>;
    Context: ServiceMap.Service<Self, Runtime>;
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
  <context extends Serverless.ExecutionContext>(
    createExecutionContext: (id: string) => context,
  ): FunctionClass<R, context, Services | RuntimeServices> => {
    type PropsShape =
      | {
          [prop in keyof Exclude<R["Props"], undefined>]: Input<
            Exclude<R["Props"], undefined>[prop]
          >;
        }
      | undefined;
    type Props =
      | PropsShape
      | Effect.Effect<PropsShape, never, Services | context>;
    type Impl = Effect.Effect<Http.HttpEffect, never, Services | context>;

    const resource = Resource(type);
    const context = ExecutionContext<Serverless.ExecutionContext>(type);
    const self = Self<R>(type);

    const constructor = () => (id: string, props: Props) => {
      const tag = ServiceMap.Service<Self, R>(`${type}<${id}>`);
      return class {
        static [Symbol.iterator](): Iterator<
          Effect.Yieldable<any, void, never, Self>,
          Resource,
          void
        > {
          return new SingleShotGen(this) as any;
        }
        static asEffect = () => tag.asEffect();
        static pipe(...args: any[]) {
          // @ts-expect-error
          return pipe(this.asEffect(), ...args);
        }
        static make = (impl: Impl) =>
          Layer.effect(
            tag,
            Effect.flatMap(
              Effect.all([
                Effect.isEffect(props)
                  ? props
                  : Effect.succeed(props ?? ({} as PropsShape)),
                Effect.sync(() => createExecutionContext(id)),
                Effect.services<never>(),
              ]),
              Effect.fnUntraced(function* ([
                props,
                executionContext,
                outerServices,
              ]) {
                const instance = yield* resource(id, props as any);

                yield* impl.pipe(
                  Effect.flatMap((impl) =>
                    impl ? executionContext.serve(impl) : Effect.void,
                  ),
                  Effect.provide(
                    Layer.provideMerge(
                      Layer.mergeAll(
                        Layer.succeed(context, executionContext),
                        Layer.succeed(ExecutionContext, executionContext),
                        Layer.succeed(Serverless.Context, executionContext),
                        Layer.succeed(resource.Self, instance),
                        Layer.succeed(Self, instance),
                      ),
                      Layer.succeedServices(outerServices),
                    ),
                  ),
                );

                // @ts-expect-error
                instance.Props = {
                  ...props,
                  env: {
                    ...props?.env,
                    ...executionContext.env,
                  },
                } as PropsShape;

                return Object.assign(instance, {
                  ExecutionContext: executionContext,
                }) as R;
              }),
            ),
          );
      };
    };

    return Object.assign(constructor, resource, {
      Context: context,
      Self: self,
    }) as any;
  };
