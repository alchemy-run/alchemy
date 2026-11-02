import * as Provider from "alchemy/Provider";
import { Random, RandomProvider } from "alchemy/Random";
import * as Layer from "effect/Layer";
import { EntityProvider, EntityResource } from "./Entity.ts";
import { Runners, RunnersProvider } from "./Runners.ts";

/** Service tag bundling every Effect Cluster provider. */
export class Providers extends Provider.ProviderCollection<Providers>()("EffectCluster") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * The Effect Cluster providers Layer. Add it next to the providers of the
 * cloud your database and runners run on.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Layer.mergeAll(Docker.providers(), EffectCluster.providers()) }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([EntityResource, Runners, Random])).pipe(
    Layer.provide(Layer.mergeAll(EntityProvider(), RunnersProvider(), RandomProvider())),
  );
