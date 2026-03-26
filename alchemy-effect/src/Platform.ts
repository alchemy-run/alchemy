import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { SingleShotGen } from "effect/Utils";
import type { PolicyLike } from "./Binding.ts";
import * as Serverless from "./ExecutionContext.ts";
import {
  ExecutionContext,
  type BaseExecutionContext,
} from "./ExecutionContext.ts";
import * as Http from "./Http.ts";
import type { Input } from "./Input.ts";
import type { Provider } from "./Provider.ts";
import {
  Resource,
  type ResourceLike,
  type ResourceProviders,
} from "./Resource.ts";
import { Self } from "./Self.ts";
import type { Stack, StackServices } from "./Stack.ts";
import type { Stage } from "./Stage.ts";

// services provided to the Resource
type PlatformServices =
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

export type PlatformEffect<
  Resource extends ResourceLike,
  Shape extends PlatformMain | void,
  Req = never,
> = Effect.Effect<
  void extends Shape ? Resource : Rpc<Resource, Shape>,
  never,
  Provider<Resource> | Req
> & {
  initPromise(): Promise<void extends Shape ? never : Shape>;
};

export type PlatformClass<
  Self extends ResourceLike,
  Runtime extends BaseExecutionContext,
  Services,
> = PlatformConstructor<Self, Services> &
  Effect.Effect<PlatformConstructor<Self, Services>> & {
    provider: ResourceProviders<Self>;
    Self: ServiceMap.Service<Self, Self>;
    Context: ServiceMap.Service<Self, Runtime>;
  };

export type PlatformArgs<
  Resource extends ResourceLike,
  Req,
> = undefined extends Resource["Props"]
  ? [
      props?:
        | {
            [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
          }
        | Effect.Effect<
            {
              [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
            },
            never,
            Req
          >,
    ]
  : [
      props:
        | {
            [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
          }
        | Effect.Effect<
            {
              [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
            },
            never,
            Req
          >,
    ];

export interface PlatformMain {
  fetch?: Http.HttpEffect;
  [key: string]: any;
}

export type Rpc<Resource extends ResourceLike, Shape> = Resource & Shape;

type PlatformReq<Resource extends ResourceLike, ProvidedServices = never> =
  | PlatformServices
  | ProvidedServices
  | Self
  | Resource
  | ServiceMap.Service<Resource, Resource>;

export interface PlatformConstructor<
  Resource extends ResourceLike,
  ProvidedServices = never,
> {
  Props: Resource["Props"];
  Req: PlatformReq<Resource, ProvidedServices>;

  <Self, Shape extends PlatformMain | void = PlatformMain>(): <
    const Id extends string,
    Req = never,
  >(
    id: Id,
    ...props: PlatformArgs<Resource, Req>
  ) => Effect.Effect<Resource, never, Provider<Resource> | Self> & {
    new (_: never): {
      LogicalId: Id;
    };
    make<Req extends PlatformReq<Resource, ProvidedServices> = never>(
      impl: Effect.Effect<Shape, never, Req>,
    ): Layer.Layer<
      Self,
      never,
      | Provider<Resource>
      | Exclude<Req, RuntimeServices | ProvidedServices | Resource | Self>
    >;
  };

  <const Id extends string, Req = never>(
    id: Id,
    ...props: PlatformArgs<Resource, Req>
  ): (<Shape extends PlatformMain | void, Req extends this["Req"] = never>(
    impl: Effect.Effect<Shape, never, Req>,
  ) => PlatformEffect<
    Resource,
    Shape,
    Exclude<Req, RuntimeServices | ProvidedServices | Resource | Self>
  >) &
    // if yielded directly, then this is an external Platform (no generator to run, only a main entrypoint to bundle)
    PlatformEffect<
      Resource,
      any, // TODO(sam): allow this to be set (e.g. to typeof import("./worker.ts"))
      Exclude<Req, RuntimeServices | ProvidedServices | Resource | Self>
    >;

  <
    const Id extends string,
    Shape extends PlatformMain | void,
    PropsReq = never,
    Req extends PlatformReq<Resource, ProvidedServices> = never,
  >(
    id: Id,
    props:
      | {
          [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
        }
      | Effect.Effect<
          | {
              [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
            }
          | (undefined extends Resource["Props"] ? undefined : never),
          never,
          PropsReq
        >
      | (undefined extends Resource["Props"] ? undefined : never),
    impl: Effect.Effect<Shape, never, Req>,
  ): PlatformEffect<
    Resource,
    Shape,
    Exclude<
      PropsReq | Req,
      RuntimeServices | PlatformReq<Resource, ProvidedServices>
    >
  >;

  asEffect(): Effect.Effect<Resource, never, Provider<Resource>>;

  [Symbol.iterator](): Effect.Yieldable<
    Effect.Effect<Resource, never, Provider<Resource>>,
    Resource,
    never,
    Provider<Resource>
  >;
}

export interface Platform<
  Context extends BaseExecutionContext = BaseExecutionContext,
> {
  Context: Context;
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
  ): <Ctx extends Context>(
    createExecutionContext: (id: string) => Ctx,
  ) => PlatformClass<R, Ctx, Services | RuntimeServices>;
}

export const Platform =
  <P extends Platform>() =>
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
  <Ctx extends P["Context"]>(
    createExecutionContext: (id: string) => Ctx,
  ): PlatformClass<R, Ctx, Services | RuntimeServices> => {
    type PropsShape =
      | {
          [prop in keyof Exclude<R["Props"], undefined>]: Input<
            Exclude<R["Props"], undefined>[prop]
          >;
        }
      | undefined;
    type Props = PropsShape | Effect.Effect<PropsShape, never, Services | Ctx>;
    type Impl = Effect.Effect<
      {
        fetch: Http.HttpEffect;
      },
      never,
      Services | Ctx
    >;

    const resource = Resource(type);
    const Ctx = ExecutionContext<Ctx>(type);
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
                    impl ? executionContext.serve(impl.fetch) : Effect.void,
                  ),
                  Effect.provide(
                    Layer.provideMerge(
                      Layer.mergeAll(
                        Layer.succeed(Ctx, executionContext),
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
      Context: Ctx,
      Self: self,
    }) as any;
  };
