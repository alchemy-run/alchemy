import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { SingleShotGen } from "effect/Utils";
import type { PolicyLike } from "./Binding.ts";
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

export interface Platform<Resource = any> {
  kind: "Platform";
  Resource: Resource;
}

export declare namespace Platform {
  export interface Class<
    Self = any,
    Platform extends BaseExecutionContext = BaseExecutionContext,
    PlatformServices = never,
  > extends ServiceMap.Service<Self, Platform> {
    Context: Platform;
    <
      Resource extends ResourceLike<
        string,
        | {
            env?: Record<string, any>;
            exports?: string[];
          }
        | undefined
      >,
      LocalServices = never,
    >(
      type: Resource["Type"],
    ): <Plat extends Platform>(
      createExecutionContext: (id: string) => Plat,
    ) => PlatformDeclaration<
      Resource,
      Plat,
      GlobalDependencies | PlatformServices | LocalServices
    >;
  }
}

export type PlatformDeclaration<
  Resource extends ResourceLike,
  PlatformContext extends BaseExecutionContext,
  PlatformServices,
> = PlatformConstructor<Resource, PlatformServices> & {
  provider: ResourceProviders<Resource>;
  Self: Self<Resource>;
  Platform: ServiceMap.Service<Platform<Resource>, PlatformContext>;
  Props: Resource["Props"];
  Services: PlatformReq<Resource, PlatformServices>;
};

export interface PlatformConstructor<
  Resource extends ResourceLike,
  PlatformServices = never,
> {
  asEffect(): Effect.Effect<Resource, never, Provider<Resource>>;

  [Symbol.iterator](): Effect.Yieldable<
    Effect.Effect<Resource, never, Provider<Resource>>,
    Resource,
    never,
    Provider<Resource>
  >;

  <
    Self,
    Shape extends PlatformMain<PlatformServices> | void =
      PlatformMain<PlatformServices>,
  >(): <const Id extends string, Req = never>(
    id: Id,
    ...props: PlatformArgs<Resource, Req>
  ) => Effect.Effect<Resource, never, Provider<Resource> | Self> & {
    new (_: never): {
      LogicalId: Id;
    };
    make<Req extends PlatformReq<Resource, PlatformServices> = never>(
      impl: Effect.Effect<Shape, never, Req>,
    ): Layer.Layer<
      Self,
      never,
      Provider<Resource> | Exclude<Req, PlatformServices | Resource | Self>
    >;
  };

  <const Id extends string, Req = never>(
    id: Id,
    ...props: PlatformArgs<Resource, Req>
  ): (<
    Shape extends PlatformMain<PlatformServices> | void,
    Req extends PlatformReq<Resource, PlatformServices> = never,
  >(
    impl: Effect.Effect<Shape, never, Req>,
  ) => PlatformEffect<
    Resource,
    Shape,
    PlatformServices,
    Exclude<Req, PlatformServices | Resource | Self>
  >) &
    // if yielded directly, then this is an external Platform (no generator to run, only a main entrypoint to bundle)
    PlatformEffect<
      Resource,
      any, // TODO(sam): allow this to be set (e.g. to typeof import("./worker.ts"))
      Exclude<Req, PlatformServices | Resource | Self>
    >;

  <
    const Id extends string,
    Shape extends PlatformMain<PlatformServices> | void,
    PropsReq = never,
    Req extends PlatformReq<Resource, PlatformServices> = never,
  >(
    id: Id,
    props: PlatformProps<Resource, PropsReq>,
    impl: Effect.Effect<Shape, never, Req>,
  ): PlatformEffect<
    Resource,
    Shape,
    PlatformServices,
    Exclude<PropsReq | Req, PlatformReq<Resource, PlatformServices>>
  >;
}

export const Platform = <P extends Platform.Class<any, any, any>>(): P =>
  (<
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
    <Platform extends P["Context"]>(
      createExecutionContext: (id: string) => Platform,
    ): PlatformDeclaration<R, Platform, Services> => {
      type PropsShape =
        | {
            [prop in keyof Exclude<R["Props"], undefined>]: Input<
              Exclude<R["Props"], undefined>[prop]
            >;
          }
        | undefined;
      type Props =
        | PropsShape
        | Effect.Effect<PropsShape, never, Services | Platform>;
      type Impl = Effect.Effect<
        {
          fetch: Http.HttpEffect;
        },
        never,
        Services | Platform
      >;

      const resource = Resource(type);
      const Platform = ExecutionContext<Platform>(type);

      const constructor = (id?: string, props?: Props, impl?: Impl) => {
        if (!id) {
          // impl was not provided inline, this is a tagged instance
          // e.g.
          // export class Sandbox extends Cloudflare.Container<Sandbox>()(..) {}
          //
          // export const SandboxLive = Sandbox.make(..)
          return makeClass;
        } else if (!impl) {
          // this is a non-tagged, curried constructor
          // e.g.
          // export default Cloudflare.Worker("id", { main: "./src/worker.ts" })(
          //   Effect.gen(function* () { .. })
          // )
          // or
          // export default Effect.gen(function* () { .. }).pipe(
          //   Cloudflare.Worker("id", { main: "./src/worker.ts" })
          // )
          const cls = makeClass(id, props);
          return Object.assign(
            (impl: Impl) => cls.asEffect().pipe(Effect.provide(cls.make(impl))),
            // we splice in the Effect so this can be yielded to indicate a non-Effect native instance
            // e.g. here, we yield it - in this case we don't want to provide an implementation
            // const worker = yield* Cloudflare.Worker("id", {
            //  main: "./src/worker.ts"
            // });
            cls,
          );
        } else {
          // impl was provided inline, this is a non-tagged eager instance
          // e.g.
          // export default Cloudflare.Worker("id", { main: "./src/worker.ts" }, Effect.gen(function* () { .. })
          const cls = makeClass(id, props);
          return cls.asEffect().pipe(Effect.provide(cls.make(impl)));
        }
      };

      const makeClass = (id: string, props: Props) => {
        return class Platform {
          static readonly Self = Self(`${type}<${id}>`);
          static readonly Platform = ServiceMap.Service<Platform, Platform>(
            `Platform<${type}<${id}>>`,
          );
          static [Symbol.iterator](): Iterator<
            Effect.Yieldable<any, void, never, Self>,
            Resource,
            void
          > {
            return new SingleShotGen(this) as any;
          }
          static asEffect = () => Self.asEffect();
          static pipe(...args: any[]) {
            // @ts-expect-error
            return pipe(this.asEffect(), ...args);
          }
          static make = (impl: Impl) => {
            // build the Layer once for the root Self
            const SelfLayer = Layer.effect(
              Self,
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
                          Layer.succeed(Platform.Platform, executionContext),
                          Layer.succeed(ExecutionContext, executionContext),
                          Layer.succeed(resource.Self, instance),
                          Layer.succeed(Platform.Self, instance),
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
            const self = Self.asEffect() as any; // TODO(sam): why do we need to cast?

            return Layer.provideMerge(
              Layer.mergeAll(
                // sets the Context for all self-hierarchies
                // Self
                // Self<Cloudflare.Worker>
                // Self<Cloudflare.Worker<Api>>
                Layer.effect(Self<R>(type), self),
                Layer.effect(Self<R>(`${type}<${id}>`), self),
              ),
              // provide here so we build once and just mirror
              SelfLayer,
            );
          };
        };
      };

      return Object.assign(constructor, resource, {
        Platform: Platform,
        Self: self,
      }) as any;
    }) as unknown as P;

type PlatformArgs<
  Resource extends ResourceLike,
  Services,
> = undefined extends Resource["Props"]
  ? [props?: PlatformProps<Resource, Services>]
  : [props: PlatformProps<Resource, Services>];

type PlatformProps<Resource extends ResourceLike, Services> =
  | {
      [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
    }
  | Effect.Effect<
      {
        [prop in keyof Resource["Props"]]: Input<Resource["Props"][prop]>;
      },
      never,
      Services
    >
  | (undefined extends Resource["Props"] ? undefined : never);

type PlatformReq<Resource extends ResourceLike, PlatformServices = never> =
  | InfrastructureServices
  | PlatformServices
  | Self
  | Self<Resource>;

type GlobalDependencies = ExecutionContext | HttpClient | Scope;

// services provided to the Resource
type InfrastructureServices =
  | Provider<any>
  | PolicyLike
  | Stack
  | Stage
  | Scope
  | StackServices;

// services provided at runtime
type RuntimeServices<
  SelfContext extends ServiceMap.Service<any, BaseExecutionContext>,
> = ExecutionContext | SelfContext | HttpClient | Scope;

export interface PlatformMain<Services> {
  fetch?: Http.HttpEffect<Services>;
  [key: string]: any;
}

export type Rpc<Resource extends ResourceLike, Shape> = Resource & Shape;

export type PlatformEffect<
  Resource extends ResourceLike,
  Shape extends PlatformMain<PlatformServices> | void,
  PlatformServices = never,
  Services = never,
> = Effect.Effect<
  void extends Shape ? Resource : Rpc<Resource, Shape>,
  never,
  Provider<Resource> | Services
> & {
  initPromise(): Promise<void extends Shape ? never : Shape>;
};
