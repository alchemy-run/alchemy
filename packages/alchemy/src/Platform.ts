/** @effect-diagnostics anyUnknownInErrorContext:off */

import type { NodeServices } from "@effect/platform-node/NodeServices";
import * as ConfigError from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Scope } from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Dependencies } from "./Dependencies.ts";
import type { ExecutionContext } from "./ExecutionContext.ts";
import type { HttpEffect } from "./Http.ts";
import type { InputProps } from "./Input.ts";
import type { Named, Tag } from "./Named.ts";
import * as Output from "./Output.ts";
import { ALCHEMY_PHASE } from "./Phase.ts";
import type { Provider, ProviderCollectionLike } from "./Provider.ts";
import { Resource, type ResourceLike } from "./Resource.ts";
import type { Rpc } from "./Rpc.ts";
import {
  CurrentRuntimeContext,
  RuntimeContext,
  sanitizeKey,
  type BaseRuntimeContext,
} from "./RuntimeContext.ts";
import { Self } from "./Self.ts";
import { ServerHost, type ProcessContext } from "./Server/Process.ts";
import type { Stack, StackServices } from "./Stack.ts";
import type { Stage } from "./Stage.ts";
import { effectClass } from "./Util/effect.ts";

export interface PlatformProps {
  /**
   * @internal type used to signal when this is an effect-native implementation
   * @default false
   */
  isExternal?: boolean;
}

export type Main<InitServices = never> = void | {
  fetch?:
    | HttpEffect<InitServices | PlatformServices | RuntimeContext | Scope>
    | Effect.Effect<
        HttpEffect<InitServices | PlatformServices | RuntimeContext | Scope>,
        never,
        InitServices | PlatformServices
      >;
};

export interface MainRpc<Req = never> {
  [key: string]:
    | Effect.Effect<
        any,
        any,
        PlatformServices | RuntimeContext | HttpServerRequest | Scope | Req
      >
    | Stream.Stream<
        any,
        any,
        PlatformServices | RuntimeContext | HttpServerRequest | Scope | Req
      >
    | ((
        ...args: any[]
      ) =>
        | Effect.Effect<
            any,
            any,
            PlatformServices | RuntimeContext | Scope | Req
          >
        | Stream.Stream<
            any,
            any,
            PlatformServices | RuntimeContext | Scope | Req
          >);
}

// Strip `void`/`undefined`/`never` from `Shape` before intersecting it with
// `BaseShape`. This matters when `Shape` fails its `extends MainShape`
// constraint (e.g. a `fetch` handler that leaks an error): TS clamps `Shape`
// to the constraint union `void | { fetch: ... }`, and a *distributive*
// conditional would split that into `BaseShape | ({ fetch } & BaseShape)` — a
// union. Feeding a union into the `new (_: never): ...` construct signature
// makes the base class a union type, which surfaces as the cryptic
// ts(2509) "Base constructor return type ... is not an object type" instead of
// the real assignability error on the `impl` argument. Excluding `void` here
// keeps the construct-sig return a single object type, so only the actionable
// error remains.
export type MakeShape<Shape, BaseShape> = [
  Exclude<Shape, void | undefined>,
] extends [never]
  ? Exclude<BaseShape, void | undefined>
  : Exclude<Shape, void | undefined> & Exclude<BaseShape, void | undefined>;

// services provided to the Resource
export type PlatformServices =
  | NodeServices
  | ExecutionContext
  | HttpClient
  | Provider<any>
  | ProviderCollectionLike
  | Scope
  | Stack
  | StackServices
  | Stage;

export interface Platform<
  Resource extends ResourceLike<string, PlatformProps>,
  Services,
  MainShape,
  RuntimeContext extends BaseRuntimeContext,
  BaseShape = {},
> extends Effect.Effect<Resource & RuntimeContext, never, Resource> {
  Type: Resource["Type"];
  Provider: Provider<Resource>;

  <Self, Shape, Deps = never>(): {
    <const Id extends string>(
      id: Id,
    ): Effect.Effect<
      Resource & Rpc<Self> & Dependencies<Deps>,
      never,
      Resource["Providers"]
    > &
      Named<Id> & {
        make<PropsReq = never, InitReq = never>(
          props:
            | InputProps<Resource["Props"]>
            | Effect.Effect<
                InputProps<Resource["Props"]>,
                ConfigError.ConfigError,
                PropsReq
              >,
          impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
        ): Layer.Layer<
          Self,
          never,
          | Resource["Providers"]
          | Exclude<PropsReq | InitReq, Services | PlatformServices | Resource>
        >;
        new (
          _: never,
        ): MakeShape<Shape, BaseShape> & Named<Id> & Tag<Resource["Type"]>;
        of(shape: Shape & MainShape): MakeShape<Shape, BaseShape>;
      };
  };
  <Self>(): {
    <
      const Id extends string,
      Shape extends MainShape,
      PropsReq = never,
      InitReq extends Services | PlatformServices | Resource = never,
    >(
      id: Id,
      props:
        | InputProps<Resource["Props"]>
        | Effect.Effect<Resource["Props"], ConfigError.ConfigError, PropsReq>,
      impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
    ): Effect.Effect<
      Resource & Rpc<Self>,
      never,
      | Resource["Providers"]
      | Exclude<PropsReq, Services | PlatformServices | Resource>
      | Exclude<InitReq, Services | PlatformServices | Resource>
    > &
      Named<Id> & {
        new (
          _: never,
        ): MakeShape<Shape, BaseShape> & Named<Id> & Tag<Resource["Type"]>;
      };

    <const Id extends string>(
      id: Id,
    ): Effect.Effect<Resource & Rpc<Self>, never, Resource["Providers"]> &
      Named<Id> & {
        make<
          PropsReq = never,
          InitReq extends Services | PlatformServices | Resource = never,
        >(
          props:
            | InputProps<Resource["Props"]>
            | Effect.Effect<
                InputProps<Resource["Props"]>,
                ConfigError.ConfigError,
                PropsReq
              >,
          impl: Effect.Effect<MainShape, ConfigError.ConfigError, InitReq>,
        ): Layer.Layer<
          Self,
          never,
          | Resource["Providers"]
          | Exclude<PropsReq | InitReq, Services | PlatformServices | Resource>
        >;
        new (_: never): BaseShape & Named<Id> & Tag<Resource["Type"]>;
      };
  };
  <PropsReq = never, InitReq extends Services | PlatformServices = never>(
    id: string,
    props:
      | InputProps<Resource["Props"]>
      | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
  ): Effect.Effect<
    Resource,
    never,
    | Resource["Providers"]
    | PropsReq
    | Exclude<InitReq, Services | PlatformServices>
  >;
  <
    const Id extends string,
    Shape extends MainShape,
    PropsReq = never,
    InitReq extends Services | PlatformServices = never,
  >(
    id: Id,
    props:
      | InputProps<Resource["Props"]>
      | Effect.Effect<InputProps<Resource["Props"]>, never, PropsReq>,
    impl: Effect.Effect<Shape, ConfigError.ConfigError, InitReq>,
  ): Effect.Effect<
    Resource & Rpc<Shape> & Named<Id>,
    never,
    | Resource["Providers"]
    | PropsReq
    | Exclude<InitReq, Services | PlatformServices>
  > &
    Named<Id>;
}

export const Platform = <
  R extends ResourceLike<
    string,
    | {
        env?: Record<string, any>;
        exports?: string[] | Record<string, any>;
      }
    | undefined
  >,
>(
  type: R["Type"],
  hooks: {
    createRuntimeContext: (id: string) => BaseRuntimeContext;
    // `onCreate` runs inside the resource-construction context, which already
    // carries the Stack's providers — so the hook may yield child resources
    // (e.g. an async Worker registering a `WorkflowResource` for a bound
    // Workflow). Allow an ambient requirement (`any`) rather than forcing
    // `never`; it is discharged by the surrounding provider context.
    onCreate?: (resource: R, props: any) => Effect.Effect<void, never, any>;
  },
  methods?: { [key: string]: any },
): any => {
  type Props = any;
  type Impl = Effect.Effect<any>;

  const resource = Resource(type);
  const PlatformContext = RuntimeContext;

  const constructor = (
    id?: string,
    props?: any,
    impl?: Impl,
    isTag = false,
  ): any => {
    if (!id) {
      // impl was not provided inline, this is a tagged instance
      // e.g.
      // export class Sandbox extends Cloudflare.Container<Sandbox>()(..) {}
      //
      // export const SandboxLive = Sandbox.make(..)
      return (id: string, props?: any, impl?: Impl) =>
        constructor(id, props, impl, true);
    } else if (!impl) {
      const cls = makeClass(id);
      const evaluate = () =>
        (!isTag
          ? // this is a non-tagged resource yielded without providing an implementation
            // e.g.
            // yield* Cloudflare.Worker("id", { main: "./src/worker.ts" })
            //
            // This is where we bridge to non-effect, e.g. bundling an ordinary worker
            // export default {
            //   fetch: (request: Request) => {
            //     return new Response("Hello, world!");
            //   }
            // }
            resource(
              id,
              Effect.isEffect(props)
                ? Effect.map(props, (p: any) => ({ ...p, isExternal: true }))
                : {
                    ...props,
                    isExternal: true,
                  },
            )
          : Effect.flatMap(
              // this is a tagged resource
              Effect.serviceOption(cls.Self),
              Option.match({
                // we are likely running at runtime, so we create
                onNone: () => resource(id, props),
                onSome: Effect.succeed,
              }),
            )
        ).pipe(
          Effect.tap((resource) =>
            hooks.onCreate
              ? Effect.flatMap(
                  // `props` may itself be an Effect (e.g. when wrapped by
                  // `Cloudflare.Website.Vite` via `Effect.map`); resolve it before
                  // handing it to the hook so `onCreate` always sees the
                  // plain props object — the second call site (in
                  // `cls.make`) already does this.
                  Effect.isEffect(props) ? props : Effect.succeed(props ?? {}),
                  (resolved) => hooks.onCreate!(resource as R, resolved),
                )
              : Effect.void,
          ),
        );
      return Object.assign(
        function (props: Props, impl: Impl) {
          return cls.Self.pipe(Effect.provide(cls.make(props, impl)));
        },
        // we splice in the Effect so this can be yielded to indicate a non-Effect native instance
        // e.g. here, we yield it - in this case we don't want to provide an implementation
        // const worker = yield* Cloudflare.Worker("id", {
        //  main: "./src/worker.ts"
        // });
        cls,
        // Spread the Effect prototype LAST so it overrides the evaluate copied
        // from `cls`: yielding this no-impl form bridges to the (possibly
        // non-Effect-native) resource rather than resolving the Self tag.
        Effectable.Prototype({
          label: `${type}<${id}>`,
          evaluate,
        }),
      );
    } else {
      // impl was provided inline, this is a non-tagged eager instance
      // e.g.
      // export default Cloudflare.Worker("id", { main: "./src/worker.ts" }, Effect.gen(function* () { .. })
      const cls = makeClass(id);
      return cls.Self.pipe(Effect.provide(cls.make(props, impl)), effectClass);
    }
  };

  const makeClass = (id: string) => {
    class Platform {
      static readonly Self = Self(`${type}<${id}>`);
      static readonly Platform = Context.Service<Platform, Platform>(
        `Platform<${type}<${id}>>`,
      );
      static of = (shape: any) => shape;
      static make = (props: Props, impl: Impl) => {
        // build the Layer once for the root Self
        const SelfLayer = Layer.effect(
          Self,
          Effect.flatMap(
            Effect.all([
              Effect.isEffect(props) ? props : Effect.succeed(props ?? {}),
              Effect.sync(() => hooks.createRuntimeContext(id)),
              Effect.context<never>(),
            ]),
            Effect.fn(function* ([props, runtimeContext, outerServices]) {
              const instance = Object.assign(
                yield* resource(id, props as any).pipe(
                  Effect.flatMap(
                    (resource) =>
                      hooks
                        .onCreate?.(resource, props)
                        .pipe(Effect.map(() => resource)) ??
                      Effect.succeed(resource),
                  ),
                ),
                runtimeContext,
              );

              yield* impl.pipe(
                Effect.flatMap((impl) => {
                  if (!impl) return Effect.void;
                  const shape = impl as Record<string, unknown>;
                  // Serve when there's a `fetch` handler OR any RPC shape
                  // methods. A pure-RPC impl (methods, no `fetch`) still needs
                  // the server to boot — hand `serveRpc` a default 404 fallback
                  // so `/__rpc__/*` is dispatched to the shape methods and
                  // everything else 404s.
                  // May be an `HttpEffect` or an Effect resolving to one (the
                  // `Main.fetch` shape); `serve` accepts both.
                  const fetch = shape.fetch as any;
                  const hasRpcMethods = Object.keys(shape).some(
                    (key) => key !== "fetch",
                  );
                  if (!fetch && !hasRpcMethods) return Effect.void;
                  // Hand the full impl to `serve` so the runtime can expose any
                  // non-handler methods on the impl shape (RPC methods)
                  // alongside the standard `fetch` handler.
                  return (
                    runtimeContext.serve?.(
                      fetch ??
                        Effect.succeed(
                          HttpServerResponse.text("Not Found", { status: 404 }),
                        ),
                      { shape },
                    ) ?? Effect.die("No serve handler")
                  );
                }),
                Effect.provide(
                  Layer.effect(
                    ConfigProvider.ConfigProvider,
                    Effect.gen(function* () {
                      // a Config Provider that we use to intercept config lookups and bind them to the RuntimeContext
                      const configProvider =
                        yield* ConfigProvider.ConfigProvider;
                      const phase = yield* ALCHEMY_PHASE;

                      return ConfigProvider.make(
                        Effect.fn(function* (path) {
                          const ctx = yield* CurrentRuntimeContext;
                          // `set`/`get` store keys verbatim, so canonicalize the
                          // logical config path here (the caller's job) before
                          // handing it to the RuntimeContext.
                          const key = sanitizeKey(
                            path.map((p) => p.toString()).join("_"),
                          );
                          const node = yield* configProvider.load(path);
                          if (phase === "plan" && node) {
                            // bind it to the RuntimeContext if running in plan phase
                            const output = Output.literal(
                              Redacted.make(node.value),
                            );
                            yield* ctx?.set(key, output) ?? Effect.void;
                            return node;
                          } else if (phase === "runtime" && ctx) {
                            // retrieve from the RuntimeContext if running in runtime phase
                            const value =
                              yield* ctx.get<Redacted.Redacted<string>>(key);
                            if (value) {
                              return ConfigProvider.makeValue(
                                Redacted.isRedacted(value)
                                  ? Redacted.value(value)
                                  : value,
                              );
                            }
                          }
                          // fallback to the config provider otherwise
                          return node;
                        }),
                      );
                    }),
                  ).pipe(
                    Layer.provideMerge(
                      Layer.mergeAll(
                        Layer.succeed(Platform.Platform, runtimeContext),
                        Layer.succeed(PlatformContext, runtimeContext),
                        Layer.succeed(RuntimeContext, runtimeContext),
                        // Host contexts (EC2 instances, ECS tasks, processes)
                        // carry a `run` for registering long-running loops.
                        // Expose it as `ServerHost` so an inline program can
                        // `yield* ServerHost` during plan/deploy without the
                        // caller providing the layer itself.
                        "run" in runtimeContext &&
                          typeof (runtimeContext as { run?: unknown }).run ===
                            "function"
                          ? Layer.succeed(ServerHost, {
                              run: (runtimeContext as ProcessContext).run,
                            })
                          : Layer.empty,
                        Layer.succeed(resource.Self, instance),
                        Layer.succeed(Platform.Self, instance),
                        Layer.succeed(Self, instance),
                        runtimeContext.planServices
                          ? Layer.unwrap(
                              ALCHEMY_PHASE.pipe(
                                Effect.map((phase) =>
                                  phase === "plan"
                                    ? runtimeContext.planServices!
                                    : Layer.empty,
                                ),
                              ),
                            )
                          : Layer.empty,
                      ),
                    ),
                    Layer.provideMerge(Layer.succeedContext(outerServices)),
                  ),
                ),
              );

              instance.Props = {
                ...props,
                env: {
                  ...props?.env,
                  ...runtimeContext.env,
                },
                exports: runtimeContext.exports
                  ? yield* runtimeContext.exports
                  : undefined,
              };

              return Object.assign(instance, {
                RuntimeContext: runtimeContext,
              }) as R;
            }),
          ),
        );
        const self = Self as any; // TODO(sam): why do we need to cast?

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
    }
    // Make the platform class itself a real Effect: `yield* MyWorker` resolves
    // the Self tag. Replaces the hand-rolled asEffect/pipe/[Symbol.iterator].
    return Object.assign(
      Platform,
      Effectable.Prototype({
        label: `${type}<${id}>`,
        evaluate: () => Platform.Self,
      }),
    );
  };

  const instance = Object.assign(
    constructor,
    resource,
    // Spread the Effect prototype LAST so it overrides any evaluate inherited
    // from `resource`; `yield* Cloudflare.Worker` resolves the resource Self.
    Effectable.Prototype({
      label: `${type}`,
      evaluate: () => resource.Self,
    }),
    {
      Platform: Platform,
      ...methods,
    },
  ) as any;
  return instance;
};
