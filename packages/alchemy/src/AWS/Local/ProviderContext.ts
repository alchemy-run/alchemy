/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import type { ProviderService } from "../../Provider.ts";
import type { ResourceLike } from "../../Resource.ts";

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

const isProviderService = (value: unknown): value is ProviderService<any> =>
  Predicate.hasProperty(value, "reconcile") &&
  Predicate.isFunction(value.reconcile);

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
export const provideProviderContext = <ROut, E, RIn>(
  providerLayer: Layer.Layer<ROut, E, RIn>,
  services: Layer.Layer<any, any, never>,
): Layer.Layer<ROut, any, RIn> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* () {
      const ambient = yield* Effect.context<never>();
      // Built via the shared MemoMap: a module-memoized `services` reference
      // is deduped to a single instance across every wrapped provider.
      const servicesCtx = yield* Layer.buildWithMemoMap(
        services,
        memoMap,
        scope,
      );
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
          isProviderService(value)
            ? withProviderContext(value, servicesLayer)
            : value,
        );
      }
      return Context.makeUnsafe(wrapped) as Context.Context<ROut>;
    }),
  ) as Layer.Layer<ROut, any, RIn>;
