import { CommandExecutorLive } from "alchemy/Command/Command";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AliasProvider, Alias } from "./Alias.ts";
import { DevProvider, Dev } from "./Dev.ts";
import { Proxy, ProxyProvider } from "./Proxy.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Portless") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Registers the Portless resource providers: `Proxy`, `Dev` and `Alias`. They
 * only act during `alchemy dev`; a plain `alchemy deploy` never starts a proxy.
 *
 * The shared proxy is acquired while this layer builds, before any resource is
 * evaluated, so it holds port 443 before another local provider, an emulator
 * that publishes ports, say, can take it.
 *
 * ```typescript
 * providers: Layer.mergeAll(Cloudflare.providers(), Portless.providers()),
 * ```
 */
export const providers = () => {
  const registration = Layer.mergeAll(
    ProxyProvider(),
    DevProvider().pipe(Layer.provide(CommandExecutorLive())),
    AliasProvider(),
  );
  // Alchemy builds a dual provider's variant on first demand, which for the proxy
  // is its first plan. Demanding it here builds it with the layer instead.
  const acquisition = Layer.effectDiscard(
    Effect.gen(function* () {
      const proxy = yield* Provider.Provider<Proxy>(Proxy.Type);
      yield* Provider.providerForMode(proxy, proxy.mode);
    }),
  ).pipe(Layer.provide(registration));
  return Layer.effect(Providers, Provider.collection([Proxy, Dev, Alias])).pipe(
    Layer.provide(Layer.merge(registration, acquisition)),
    Layer.orDie,
  );
};
