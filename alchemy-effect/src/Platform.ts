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
import type { Provider } from "./Provider.ts";
import {
  Resource,
  type ResourceLike,
  type ResourceProviders,
} from "./Resource.ts";
import { Self } from "./Self.ts";
import type { Stack, StackServices } from "./Stack.ts";
import type { Stage } from "./Stage.ts";

export type Rpc<Shape> = {
  "~alchemy-effect/rpc": Shape;
};

// services provided to the Resource
export type PlatformServices =
  | ExecutionContext
  | HttpClient
  | PolicyLike
  | Provider<any>
  | Scope
  | Stack
  | StackServices
  | Stage;

export interface Platform<
  Resource extends ResourceLike,
  Services,
  MainShape,
  ExecutionContext extends BaseExecutionContext,
  BaseShape = {},
> extends Effect.Effect<Resource & ExecutionContext, never, Services> {
  provider: ResourceProviders<Resource>;

  <Self, Shape>(): {
    <PropsReq = never>(
      id: string,
      props:
        | Resource["Props"]
        | Effect.Effect<Resource["Props"], never, PropsReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      Self | Provider<Resource> | PropsReq
    > & {
      make<InitReq = never>(
        impl: Effect.Effect<Shape, never, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        Provider<Resource> | Exclude<PropsReq | InitReq, Services>
      >;
      new (_: never): Shape & BaseShape;
    };
  };
  <Self>(): {
    <Shape, PropsReq = never, InitReq = never>(
      id: string,
      props:
        | Resource["Props"]
        | Effect.Effect<Resource["Props"], never, PropsReq>,
      impl: Effect.Effect<Shape, never, InitReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      Provider<Resource> | PropsReq | Exclude<InitReq, Services>
    > & {
      new (_: never): Shape & BaseShape;
    };
    <Shape, PropsReq = never>(
      id: string,
      props:
        | Resource["Props"]
        | Effect.Effect<Resource["Props"], never, PropsReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      Provider<Resource> | PropsReq
    > & {
      make<InitReq = never>(
        impl: Effect.Effect<Shape, never, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        Provider<Resource> | Exclude<PropsReq | InitReq, Services>
      >;
      new (_: never): Shape & BaseShape;
    } & (<InitReq = never>(
        impl: Effect.Effect<Shape, never, InitReq>,
      ) => Effect.Effect<
        Resource & Rpc<Self>,
        never,
        Provider<Resource> | PropsReq | Exclude<InitReq, Services>
      >);
  };
  <Shape extends MainShape, PropsReq = never, InitReq = never>(
    id: string,
    props:
      | Resource["Props"]
      | Effect.Effect<Resource["Props"], never, PropsReq>,
    impl: Effect.Effect<Shape, never, InitReq>,
  ): Effect.Effect<
    Resource & Rpc<Shape>,
    never,
    Provider<Resource> | PropsReq | Exclude<InitReq, Services>
  >;
}

export const Platform = <
  R extends ResourceLike<
    string,
    | {
        env?: Record<string, any>;
        exports?: string[];
      }
    | undefined
  >,
>(
  type: R["Type"],
  createExecutionContext: (id: string) => BaseExecutionContext,
): any => {
  type Props = any;
  type Impl = Effect.Effect<any>;

  const resource = Resource(type);
  const PlatformContext = ExecutionContext(type);

  const constructor = (id?: string, props?: any, impl?: Impl) => {
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
              Effect.isEffect(props) ? props : Effect.succeed(props ?? {}),
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
                      Layer.succeed(PlatformContext, executionContext),
                      Layer.succeed(resource.Self, instance),
                      Layer.succeed(Platform.Self, instance),
                      Layer.succeed(Self, instance),
                    ),
                    Layer.succeedServices(outerServices),
                  ),
                ),
              );

              instance.Props = {
                ...props,
                env: {
                  ...props?.env,
                  ...executionContext.env,
                },
              };

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

  const instance = Object.assign(constructor, resource, {
    Platform: Platform,
    Self: self,
  }) as any;
  return instance;
};
