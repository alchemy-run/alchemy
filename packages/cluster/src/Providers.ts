import * as Provider from "alchemy/Provider";
import { Random, RandomProvider } from "alchemy/Random";
import * as Layer from "effect/Layer";
import { EntityProvider, EntityResource } from "./Entity.ts";
import { Runners, RunnersProvider } from "./Runners.ts";
import { ShardGroups, ShardGroupsProvider } from "./ShardGroups.ts";

/** Service tag bundling every Effect Cluster provider. */
export class Providers extends Provider.ProviderCollection<Providers>()("Cluster") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * The Effect Cluster providers Layer. Add it next to the providers of the
 * cloud your database and runners run on.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Layer.mergeAll(Docker.providers(), Cluster.providers()) }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([EntityResource, Runners, ShardGroups, Random])).pipe(
    Layer.provide(
      Layer.mergeAll(EntityProvider(), RunnersProvider(), ShardGroupsProvider(), RandomProvider()),
    ),
  );
