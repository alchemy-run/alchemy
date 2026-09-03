import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { AlchemyContext } from "../AlchemyContext.ts";
import type { ProviderService } from "../Provider.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceLike } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { DevIngress, type ExposeInput, type Exposure } from "./DevIngress.ts";
import * as RpcProvider from "./RpcProvider.ts";
import {
  RpcProviderProxy,
  SPAWNER_URL_ENV_KEY,
  layer as rpcProviderProxyLayer,
} from "./RpcProviderProxy.ts";

/**
 * The dev ingress lives in ONE process — the Cloudflare dev sidecar, next
 * to the workerd runtime it is built on — while local providers run in
 * several: floci-wrapped AWS providers in the exec child, `Command.Dev` in
 * its own sidecar, the Lambda MicroVM provider in the AWS sidecar. This
 * module is how those processes reach the ingress: a tiny RPC-hosted
 * "route" provider whose `reconcile` is `expose` and whose `delete` is
 * `unexpose`, riding the same sidecar RPC machinery every local provider
 * already uses.
 */

/** Attributes of the synthetic route resource: the resulting exposure. */
export interface DevIngressRouteAttrs {
  readonly exposure: Exposure | undefined;
}

/** The synthetic resource type that carries ingress routes over RPC. */
export interface DevIngressRoute extends Resource<
  "alchemy/DevIngressRoute",
  Omit<ExposeInput, "fqn">,
  DevIngressRouteAttrs
> {}

export const DevIngressRoute = Resource<DevIngressRoute>(
  "alchemy/DevIngressRoute",
);

/**
 * The Cloudflare dev sidecar entry — the process hosting the ingress.
 * Resolved here (not imported from `Cloudflare/LocalRuntime.ts`) so that
 * AWS and Command providers don't pull the Cloudflare local runtime into
 * their import graph just to find the sidecar.
 */
const INGRESS_ENTRY_URL = import.meta.resolve(
  import.meta.url.endsWith(".ts")
    ? "../Cloudflare/Local.ts"
    : "../Cloudflare/Local.js",
  import.meta.url,
);

/**
 * Serve the ingress over RPC. Registered in the Cloudflare sidecar's
 * provider layer (`Cloudflare/Local.ts`), where {@link DevIngress} is the
 * real, process-wide instance.
 */
export const DevIngressRouteProvider = () =>
  RpcProvider.effect(
    DevIngressRoute,
    INGRESS_ENTRY_URL,
    Effect.gen(function* () {
      const ingress = yield* DevIngress;
      return {
        diff: () => Effect.succeed({ action: "update" as const }),
        reconcile: ({ fqn, news }) =>
          ingress
            .expose({ ...(news as Omit<ExposeInput, "fqn">), fqn })
            .pipe(Effect.map((exposure) => ({ exposure }))),
        delete: ({ fqn }) => ingress.unexpose(fqn),
      } satisfies Parameters<typeof Provider.succeed<DevIngressRoute>>[1];
    }),
  );

/**
 * A process-agnostic handle on the dev ingress: the in-process
 * {@link DevIngress} when this process hosts it, else the RPC route
 * provider in the Cloudflare sidecar (reached through the spawner URL every
 * dev process carries), else a no-op — outside `alchemy dev` nothing is
 * exposed and `expose` resolves to `undefined`.
 */
export class DevIngressClient extends Context.Service<
  DevIngressClient,
  {
    readonly expose: (
      input: ExposeInput,
    ) => Effect.Effect<Exposure | undefined>;
    readonly unexpose: (fqn: string) => Effect.Effect<void>;
  }
>()("alchemy/Local/DevIngressClient") {}

const disabled = DevIngressClient.of({
  expose: () => Effect.succeed(undefined),
  unexpose: () => Effect.void,
});

/** A stub for the lifecycle `session` argument; functions never cross the RPC wire anyway. */
const noSession = {
  note: () => Effect.void,
  status: () => Effect.void,
} as unknown as Parameters<
  ProviderService<DevIngressRoute>["reconcile"]
>[0]["session"];

const viaRouteProvider = (
  provider: ProviderService<DevIngressRoute>,
): DevIngressClient["Service"] => ({
  expose: ({ fqn, ...news }) =>
    provider
      .reconcile({
        id: fqn,
        fqn,
        instanceId: fqn,
        news,
        olds: undefined,
        output: undefined,
        bindings: [],
        session: noSession,
      })
      .pipe(
        Effect.map((attrs) => attrs.exposure),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `[${fqn}] Could not register with the dev ingress.\n${cause}`,
          ).pipe(Effect.as(undefined)),
        ),
      ),
  unexpose: (fqn) =>
    provider
      .delete({
        id: fqn,
        fqn,
        instanceId: fqn,
        olds: { type: "", upstream: "" },
        output: { exposure: undefined },
        bindings: [],
        session: noSession,
      })
      .pipe(Effect.ignore),
});

/**
 * Find an RPC proxy to the sidecars: the ambient {@link RpcProviderProxy}
 * (the exec child has one), else one built from the spawner URL in the
 * process environment (sidecars get it from the spawner), else none.
 */
const resolveProxy: Effect.Effect<
  Option.Option<RpcProviderProxy["Service"]>,
  never,
  HttpClient | Scope.Scope
> = Effect.gen(function* () {
  const ambient = yield* Effect.serviceOption(RpcProviderProxy);
  if (Option.isSome(ambient)) return ambient;
  const url = yield* Config.option(Config.string(SPAWNER_URL_ENV_KEY)).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(url)) return Option.none();
  const ctx = yield* Layer.build(rpcProviderProxyLayer(url.value)).pipe(
    Effect.orDie,
  );
  return Option.some(Context.get(ctx, RpcProviderProxy));
});

/**
 * Build the client for the current process. Requires `AlchemyContext` and
 * `Stack` (the RPC session is per stack) and an `HttpClient` for the RPC
 * transport; everything else is discovered: an in-process
 * {@link DevIngress}, or a spawner URL (`ALCHEMY_RPC_SPAWNER_URL`) either as
 * an ambient {@link RpcProviderProxy} or in the process environment.
 */
export const layer: Layer.Layer<
  DevIngressClient,
  never,
  AlchemyContext | Stack | HttpClient
> = Layer.effect(
  DevIngressClient,
  Effect.gen(function* () {
    const { ingress } = yield* AlchemyContext;
    if (ingress === undefined) return disabled;
    const local = yield* Effect.serviceOption(DevIngress);
    if (Option.isSome(local)) {
      return DevIngressClient.of({
        expose: local.value.expose,
        unexpose: local.value.unexpose,
      });
    }
    const proxy = yield* resolveProxy;
    if (Option.isNone(proxy)) return disabled;
    const provider = yield* proxy.value.get<DevIngressRoute>(
      INGRESS_ENTRY_URL,
      DevIngressRoute.Type,
    );
    return DevIngressClient.of(viaRouteProvider(provider));
  }),
);

/** How a provider's attributes map onto an ingress route. */
export interface IngressExposure<A> {
  /** Resource type shown on the ingress index (`AWS.Lambda.Function`). */
  readonly type: string;
  /** The local upstream URL to route to, or `undefined` to expose nothing. */
  readonly upstream: (attrs: A) => string | undefined;
  /** Optional per-resource subdomain override read from the props. */
  readonly options?: (props: any) => Pick<ExposeInput, "subdomain">;
}

/**
 * Wrap a provider so that every successful `reconcile` also exposes the
 * resource through the dev ingress (`<name>.<domain>`) and
 * `delete` withdraws it. Attributes are returned unchanged — emulators
 * running inside Docker (floci's CloudFront edge dialing a dev server, for
 * one) must keep dialing the raw loopback URL, so the ingress URLs
 * are surfaced on the index page and in the logs instead.
 */
export const withDevIngress = <R extends ResourceLike>(
  provider: ProviderService<R>,
  exposure: IngressExposure<R["Attributes"]>,
): ProviderService<R> =>
  new Proxy(provider, {
    get: (target, prop) => {
      const value = (target as any)[prop];
      if (prop === "reconcile" && Predicate.isFunction(value)) {
        return (...args: any[]) =>
          Effect.gen(function* () {
            const attrs: R["Attributes"] = yield* value(...args);
            const upstream = exposure.upstream(attrs);
            if (upstream === undefined) return attrs;
            const { fqn, news } = args[0] as { fqn: string; news: unknown };
            const client = yield* Effect.serviceOption(DevIngressClient);
            if (Option.isNone(client)) return attrs;
            const exposed = yield* client.value.expose({
              fqn,
              type: exposure.type,
              upstream,
              ...exposure.options?.(news),
            });
            if (exposed) {
              yield* Effect.logInfo(
                `[${fqn}] ${exposed.urls.map((url) => `→ ${url}`).join("  ")}`,
              );
            }
            return attrs;
          });
      }
      if (prop === "delete" && Predicate.isFunction(value)) {
        return (...args: any[]) =>
          Effect.gen(function* () {
            yield* value(...args);
            const { fqn } = args[0] as { fqn: string };
            const client = yield* Effect.serviceOption(DevIngressClient);
            if (Option.isSome(client)) yield* client.value.unexpose(fqn);
          });
      }
      if (!Predicate.isFunction(value)) return value;
      return (...args: any[]) => value(...args);
    },
  });

/**
 * Layer-level companion to {@link withDevIngress}: wraps every provider
 * service in `providerLayer` and provides the {@link DevIngressClient} to
 * their lifecycle effects.
 */
export const provideDevIngress = <ROut, E, RIn, A>(
  providerLayer: Layer.Layer<ROut, E, RIn>,
  exposure: IngressExposure<A>,
): Layer.Layer<ROut, E, RIn | AlchemyContext | Stack | HttpClient> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* () {
      const clientCtx = yield* Layer.buildWithMemoMap(layer, memoMap, scope);
      const built = yield* Layer.buildWithMemoMap(
        providerLayer,
        memoMap,
        scope,
      );
      const wrapped = new Map<string, any>();
      for (const [key, value] of built.mapUnsafe) {
        wrapped.set(
          key,
          isProviderService(value)
            ? withClient(withDevIngress(value, exposure), clientCtx)
            : value,
        );
      }
      return Context.makeUnsafe(wrapped) as Context.Context<ROut>;
    }),
  ) as Layer.Layer<ROut, E, RIn | AlchemyContext | Stack | HttpClient>;

const isProviderService = (value: unknown): value is ProviderService<any> =>
  Predicate.hasProperty(value, "reconcile") &&
  Predicate.isFunction(value.reconcile);

/** Provide the built client context to every lifecycle effect of `provider`. */
const withClient = <R extends ResourceLike>(
  provider: ProviderService<R>,
  clientCtx: Context.Context<DevIngressClient>,
): ProviderService<R> =>
  new Proxy(provider, {
    get: (target, prop) => {
      const value = (target as any)[prop];
      if (!Predicate.isFunction(value)) return value;
      return (...args: any[]) => {
        const result: unknown = value(...args);
        if (Stream.isStream(result)) {
          return Stream.provideContext(result, clientCtx);
        }
        if (Effect.isEffect(result)) {
          return Effect.provideContext(result, clientCtx);
        }
        return result;
      };
    },
  });
