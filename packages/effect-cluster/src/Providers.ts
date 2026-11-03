import * as Provider from "alchemy/Provider";
import { Random, RandomProvider } from "alchemy/Random";
import * as Layer from "effect/Layer";
import { CronProvider, CronResource } from "./Cron.ts";
import { EntityProvider, EntityResource } from "./Entity.ts";
import { Pool, PoolProvider } from "./Pool.ts";
import { ShardGroups, ShardGroupsProvider } from "./ShardGroups.ts";
import { SingletonProvider, SingletonResource } from "./Singleton.ts";
import { WorkflowProvider, WorkflowResource } from "./Workflow.ts";

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
  Layer.effect(
    Providers,
    Provider.collection([
      EntityResource,
      WorkflowResource,
      SingletonResource,
      CronResource,
      Pool,
      ShardGroups,
      Random,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        EntityProvider(),
        WorkflowProvider(),
        SingletonProvider(),
        CronProvider(),
        PoolProvider(),
        ShardGroupsProvider(),
        RandomProvider(),
      ),
    ),
  );
