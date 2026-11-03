import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

/** The shard groups one pool serves, bound onto its database's {@link ShardGroups}. */
export interface ShardGroupsBindingContract {
  groups?: string[];
}

export interface ShardGroupsAttributes {
  /** Every shard group in the cluster, sorted. */
  groups: string[];
}

export interface ShardGroups extends Resource<
  "Cluster.ShardGroups",
  {},
  ShardGroupsAttributes,
  ShardGroupsBindingContract,
  Providers
> {}

/**
 * Every shard group in one cluster, collected from the pools that share
 * its database. Every runner and gateway is configured with the whole list:
 * Effect Cluster numbers each shard's lock by its group's place in it, so
 * they must all agree. It owns nothing in the cloud.
 *
 * @internal
 */
export const ShardGroups = Resource<ShardGroups>("Cluster.ShardGroups");

export const ShardGroupsProvider = () =>
  Provider.succeed(ShardGroups, {
    reconcile: ({ bindings }) =>
      Effect.sync(() => ({
        groups: [...new Set(bindings.flatMap(({ data }) => data.groups ?? []))].sort(),
      })),
    delete: () => Effect.void,
  });
