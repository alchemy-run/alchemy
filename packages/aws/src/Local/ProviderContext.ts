/** @effect-diagnostics anyUnknownInErrorContext:off */

import { Endpoint } from "@distilled.cloud/aws";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import type { ProviderService } from "alchemy/Provider";
import type { ResourceLike } from "alchemy/Resource";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";

/**
 * Wraps a {@link ProviderService} so that EVERY lifecycle method
 * (`reconcile`, `diff`, `read`, `delete`, `list`, `precreate`, `tail`,
 * `logs`, ...) runs with the given services provided. The services are
 * provided *closest* to the lifecycle effect, so they override anything the
 * engine's ambient context supplies (credentials, region, endpoint,
 * environment).
 *
 * Method identity/shape is preserved exactly — the Provider interface is
 * structural, and the Proxy forwards non-function members (`version`,
 * `stables`, `aliases`, `nuke`, ...) untouched. Modeled on the lifecycle
 * Proxy in [Local/RpcProvider.ts](../../Local/RpcProvider.ts).
 */
export const withProviderContext = <R extends ResourceLike>(
  provider: ProviderService<R>,
  services: Layer.Layer<any, never, never>,
): ProviderService<R> =>
  new Proxy(provider, {
    get: (target, prop) => {
      const value = (target as any)[prop];
      if (prop === "modes" && value !== undefined) {
        // Mode-resolved variants (`findProviderByType(type, mode)`, used for
        // stamped-mode deletes and `Alchemy.remote()`) bypass this Proxy —
        // wrap the services THEY resolve to as well, so a live variant's
        // ops carry the same context. A local variant's own data-plane
        // override is provided closer and still wins.
        return Object.fromEntries(
          Object.entries(value as Record<string, Effect.Effect<any>>).map(([mode, build]) => [
            mode,
            Effect.map(build, (resolved) =>
              withProviderContext(resolved as ProviderService<R>, services),
            ),
          ]),
        );
      }
      if (!Predicate.isFunction(value)) return value;
      return (...args: any[]) => {
        const result: unknown = value(...args);
        if (Stream.isStream(result)) {
          return Stream.provide(result, services);
        }
        if (Effect.isEffect(result)) {
          return Effect.provide(result, services);
        }
        return result;
      };
    },
  });

/**
 * Capture the ambient AWS environment — the exact tag set a local data
 * plane overrides: {@link Endpoint}, {@link Region}, {@link Credentials},
 * {@link AWSEnvironment} — as a layer that reproduces it verbatim. An
 * absent Endpoint is pinned as `undefined` (the SDK default resolver), so
 * a later ambient override cannot leak in.
 */
export const captureAwsEnvironment: Effect.Effect<Layer.Layer<any, never, never>> = Effect.gen(
  function* () {
    let ctx = Context.empty();
    const endpoint = yield* Effect.serviceOption(Endpoint.Endpoint);
    ctx = Context.add(
      ctx,
      Endpoint.Endpoint,
      Option.getOrElse(endpoint, () => Effect.undefined),
    );
    const region = yield* Effect.serviceOption(Region);
    if (Option.isSome(region)) ctx = Context.add(ctx, Region, region.value);
    const credentials = yield* Effect.serviceOption(Credentials);
    if (Option.isSome(credentials)) {
      ctx = Context.add(ctx, Credentials, credentials.value);
    }
    const environment = yield* Effect.serviceOption(AWSEnvironment);
    if (Option.isSome(environment)) {
      ctx = Context.add(ctx, AWSEnvironment, environment.value);
    }
    return Layer.succeedContext(ctx) as Layer.Layer<any, never, never>;
  },
);

/**
 * Pin every provider in a collection (and every mode variant it lazily
 * resolves) to the AWS environment captured at REGISTRATION, provided
 * closest around each lifecycle effect. Providers therefore always run
 * against the environment they were registered with, regardless of the
 * caller's ambient context — which in an `alchemy dev` run is the emulator
 * (see AWS/Providers.ts): composition-time lookups get the emulator for
 * free while live-mode and mode-agnostic providers keep hitting the real
 * cloud. Local variants still win — their own data-plane override is
 * provided closer.
 */
export const pinCollectionEnvironment = <
  A extends {
    readonly kind: "ProviderCollection";
    get(service: string): ProviderService<any> | undefined;
    readonly providers: Record<string, ProviderService>;
  },
>(
  collection: A,
  environment: Layer.Layer<any, never, never>,
): A => {
  const wrap = (provider: ProviderService | undefined) => {
    if (provider === undefined) return undefined;
    // Stamp the registration-captured live environment so Binding clients
    // for `Alchemy.remote()` resources can provide it closest — in a
    // `dev` run ambient is the emulator, and an unwrapped live client
    // would miss the real cloud.
    Object.assign(provider, { liveDataPlane: () => environment });
    return withProviderContext(provider, environment);
  };
  const wrapped: Record<string, ProviderService> = {};
  for (const [type, provider] of Object.entries(collection.providers)) {
    wrapped[type] = wrap(provider)!;
  }
  return {
    ...collection,
    get: (service: string) => wrapped[service] ?? wrap(collection.get(service)),
    providers: wrapped,
  } as A;
};

const isProviderService = (value: unknown): value is ProviderService<any> =>
  Predicate.hasProperty(value, "reconcile") && Predicate.isFunction(value.reconcile);

/**
 * Layer-level companion to {@link withProviderContext}: given a provider
 * layer (e.g. `S3.BucketProvider()`) and a layer of override services,
 * returns a layer that builds both and re-registers every provider service
 * with its lifecycle methods wrapped in the override context.
 *
 * Built with `Layer.fromBuildMemo` (like `ProviderLayer.dual`) so the
 * `services` layer is built through the ambient `MemoMap`: pass a
 * **module-memoized layer reference** and it is constructed exactly once per
 * stack build no matter how many providers are wrapped with it.
 *
 * The services are also provided to the provider layer's *build* (winning
 * over the ambient context), so providers that resolve environment services
 * at layer construction see the override too.
 */
export const provideProviderContext = <ROut, E, RIn, ServicesE>(
  providerLayer: Layer.Layer<ROut, E, RIn>,
  services: Layer.Layer<any, ServicesE, never>,
  /** Applied to every wrapped provider service (e.g. {@link recreateMissing}). */
  wrap: (provider: ProviderService<any>) => ProviderService<any> = (provider) => provider,
): Layer.Layer<ROut, E | ServicesE, RIn> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* () {
      const ambient = yield* Effect.context<never>();
      // Built via the shared MemoMap: a module-memoized `services` reference
      // is deduped to a single instance across every wrapped provider.
      const servicesCtx = yield* Layer.buildWithMemoMap(services, memoMap, scope);
      const servicesLayer = Layer.succeedContext(servicesCtx);
      const built = yield* Layer.buildWithMemoMap(
        providerLayer.pipe(
          // Closest wins: overrides first, then the ambient build context.
          Layer.provide(servicesLayer),
          Layer.provide(Layer.succeedContext(ambient)),
        ) as Layer.Layer<any, any, never>,
        memoMap,
        scope,
      );
      const wrapped = new Map<string, any>();
      for (const [key, value] of built.mapUnsafe) {
        wrapped.set(
          key,
          isProviderService(value) ? wrap(withProviderContext(value, servicesLayer)) : value,
        );
      }
      return Context.makeUnsafe(wrapped) as Context.Context<ROut>;
    }),
  ) as Layer.Layer<ROut, E | ServicesE, RIn>;

/**
 * Wraps a local (emulator-backed) {@link ProviderService} so a resource the
 * emulator no longer has is recreated instead of updated. The managed floci
 * container keeps its data in memory: a Docker restart, or a recreation for
 * an image bump, empties it while local state still records every resource
 * (#2724). Without this, a resource whose `diff` doesn't look at the cloud
 * plans "no change", and one whose `reconcile` trusts the cached `output`
 * fails on its first update call (`NoSuchBucket`).
 *
 * - `diff` asks `read` whether the resource still exists. When it doesn't,
 *   it plans an update with no stable attributes, so dependents re-resolve
 *   the recreated resource's attributes (a new KMS key id, a new ARN).
 * - `reconcile` asks again and, when the resource is gone, runs as a
 *   greenfield create (`output` and `olds` undefined) under the same
 *   instance id, so engine-generated physical names are unchanged.
 *
 * A failing `read` is treated as "exists": the check only ever adds work for
 * a resource `read` positively reports missing. Providers without `read`
 * are returned unchanged.
 */
export const recreateMissing = <R extends ResourceLike>(
  provider: ProviderService<R>,
): ProviderService<R> => {
  const read = provider.read?.bind(provider);
  if (read === undefined) return provider;
  const isMissing = (input: {
    id: string;
    fqn: string;
    instanceId: string;
    olds: any;
    output: R["Attributes"] | undefined;
  }) =>
    input.output === undefined || input.olds === undefined
      ? Effect.succeed(false)
      : read({
          id: input.id,
          fqn: input.fqn,
          instanceId: input.instanceId,
          olds: input.olds,
          output: input.output,
        }).pipe(
          Effect.map((observed) => observed === undefined),
          Effect.orElseSucceed(() => false),
        );
  return new Proxy(provider, {
    get: (target, prop) => {
      if (prop === "diff") {
        return (input: Parameters<NonNullable<ProviderService<R>["diff"]>>[0]) =>
          Effect.gen(function* () {
            if (yield* isMissing(input)) {
              return { action: "update", stables: [] } as const;
            }
            return yield* target.diff?.(input) ?? Effect.undefined;
          });
      }
      if (prop === "reconcile") {
        return (input: Parameters<ProviderService<R>["reconcile"]>[0]) =>
          Effect.gen(function* () {
            if (yield* isMissing(input)) {
              yield* input.session.note(`${input.id} is missing from the emulator; recreating it`);
              return yield* target.reconcile({ ...input, output: undefined, olds: undefined });
            }
            return yield* target.reconcile(input);
          });
      }
      return (target as any)[prop];
    },
  });
};
