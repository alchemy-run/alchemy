import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { normalizeLocation, sameName } from "./Common.ts";

/** Default replication name: the region, letters and digits only. */
const defaultReplicationName = (location: string) =>
  (normalizeLocation(location) ?? "").replace(/[^a-z0-9]/g, "");

export interface ReplicationProps {
  /** Resource group of the registry. Changing it replaces the replication. */
  resourceGroup: string;
  /** Premium registry to replicate. Changing it replaces the replication. */
  registry: string;
  /**
   * Replication name: 5-50 letters and digits. If omitted, the normalized
   * region name is used (`westus2`), matching the Azure CLI convention; a
   * registry holds at most one replication per region, and a short name keeps
   * the ARM resource ID under its 256-character limit. Changing it replaces
   * the replication.
   */
  name?: string;
  /**
   * Region to replicate to; must differ from the registry's home region
   * and from other replications. Changing it replaces the replication.
   */
  location: string;
  /**
   * Route requests to this region. A disabled endpoint keeps syncing data
   * but stops serving traffic.
   * @default true
   */
  regionEndpointEnabled?: boolean;
  /**
   * Zone redundancy of the replica. Changing it replaces the replication.
   * @default Azure's default (`Disabled`)
   */
  zoneRedundancy?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Replication extends Resource<
  "Azure.ContainerRegistry.Replication",
  ReplicationProps,
  {
    /** Name of the replication. */
    replicationName: string;
    /** ARM resource ID of the replication. */
    replicationId: string;
    /** Registry being replicated. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** Replica region. */
    location: string;
    /** Whether the regional endpoint serves traffic. */
    regionEndpointEnabled: boolean;
    /** Zone redundancy of the replica. */
    zoneRedundancy: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A geo-replica of a Premium container registry. Clients pulling from the
 * registry's login server are routed to the closest replica.
 *
 * @see https://learn.microsoft.com/azure/container-registry/container-registry-geo-replication
 *
 * ### Geo-replicating a Registry
 * **Example:** Replicate to West Europe
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium",
 * });
 * const replica = yield* Azure.ContainerRegistry.Replication("westeurope", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   location: "westeurope",
 * });
 * ```
 *
 * @resource
 */
export const Replication = Resource<Replication>(
  "Azure.ContainerRegistry.Replication",
);

const getReplication = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  replicationName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetReplication({
      subscriptionId,
      resourceGroupName,
      registryName,
      replicationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  replication: containerregistry.GetReplicationResponse,
): Replication["Attributes"] => ({
  replicationName: name,
  replicationId: replication.id ?? "",
  registry,
  resourceGroup,
  location: replication.location,
  regionEndpointEnabled: replication.properties?.regionEndpointEnabled ?? true,
  zoneRedundancy: replication.properties?.zoneRedundancy ?? "Disabled",
  tags: userTags(replication.tags),
});

export const ReplicationProvider = () =>
  Provider.succeed(Replication, {
    stables: [
      "replicationName",
      "replicationId",
      "registry",
      "resourceGroup",
      "location",
    ],

    // Replications live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined &&
          !sameName(news.name, output.replicationName)) ||
        normalizeLocation(news.location) !==
          normalizeLocation(output.location) ||
        (news.zoneRedundancy !== undefined &&
          news.zoneRedundancy !== output.zoneRedundancy)
      ) {
        // A kept name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst: sameName(
            news.name ?? defaultReplicationName(news.location),
            output.replicationName,
          ),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const registry = output?.registry ?? olds?.registry;
      if (resourceGroup === undefined || registry === undefined) {
        return undefined;
      }
      const name =
        output?.replicationName ??
        olds?.name ??
        (olds?.location !== undefined
          ? defaultReplicationName(olds.location)
          : undefined);
      if (name === undefined) return undefined;
      const observed = yield* getReplication(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, registry, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const { resourceGroup, registry } = news;
      const name =
        news.name ??
        output?.replicationName ??
        defaultReplicationName(news.location);
      const tags = yield* desiredTags(id, news.tags);
      const regionEndpointEnabled = news.regionEndpointEnabled ?? true;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        replicationName: name,
      };
      const get = getReplication(subscriptionId, resourceGroup, registry, name);
      const waitReady = waitForProvisioned(
        `replication ${name}`,
        get,
        (replication) => replication.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Replica provisioning takes a few minutes.
      if (observed === undefined) {
        yield* containerregistry.CreateReplication({
          ...where,
          location: news.location,
          tags,
          properties: {
            regionEndpointEnabled,
            zoneRedundancy: news.zoneRedundancy,
          },
        });
      }
      observed = yield* waitReady;

      // Sync the endpoint flag and tags against the observed replica.
      const endpointChanged =
        (observed.properties?.regionEndpointEnabled ?? true) !==
        regionEndpointEnabled;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (endpointChanged || tagsChanged) {
        yield* containerregistry.UpdateReplication({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: endpointChanged ? { regionEndpointEnabled } : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, registry, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteReplication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registry,
          replicationName: output.replicationName,
        }),
      );
      yield* waitUntilGone(
        `replication ${output.replicationName}`,
        getReplication(
          subscriptionId,
          output.resourceGroup,
          output.registry,
          output.replicationName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerRegistry.Registry",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
