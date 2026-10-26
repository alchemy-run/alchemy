import * as eventhub from "@distilled.cloud/azure/eventhub";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createNamespaceName } from "./Common.ts";

export interface ClusterProps {
  /**
   * Resource group the cluster is created in.
   *
   * :::caution
   * Changing it replaces the cluster.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Cluster name: 6-50 letters, digits, and hyphens, starting with a letter
   * and ending with a letter or digit.
   *
   * :::caution
   * Changing it replaces the cluster.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the cluster.
   *
   * :::caution
   * Changing it replaces the cluster.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Capacity units (CUs), the unit Azure bills per hour. Changeable in place
   * only when `supportsScaling` is `true`.
   * @default 1
   */
  capacity?: number;
  /**
   * Create a self-serve scalable cluster whose capacity can change after
   * creation.
   *
   * :::caution
   * Changing it replaces the cluster.
   * :::
   * @default not sent (Azure's default, a cluster that cannot scale)
   */
  supportsScaling?: boolean;
  /**
   * Spread the cluster across availability zones.
   *
   * :::caution
   * Changing it replaces the cluster.
   * :::
   * @default not sent (Azure's default)
   */
  zoneRedundant?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.EventHub.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster; pass it as a namespace's `clusterArmId`. */
    clusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** Capacity units (CUs). */
    capacity: number | undefined;
    /** Whether capacity can change after creation. */
    supportsScaling: boolean | undefined;
    /** Whether the cluster is zone redundant. */
    zoneRedundant: boolean | undefined;
    /** Identifier for Azure Monitor metrics. */
    metricId: string | undefined;
    /** Cluster status as Azure reports it, e.g. `Active`. */
    status: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dedicated Event Hubs cluster (`Microsoft.EventHub/clusters`):
 * single-tenant capacity that hosts your namespaces. Use it when you need
 * guaranteed throughput, isolation, or limits beyond the `Premium` tier.
 * Place a namespace in it with the namespace's `clusterArmId`.
 *
 * :::caution[Dedicated clusters are expensive and have a 4-hour minimum]
 * Azure bills a cluster per capacity unit-hour (several dollars per hour
 * for each CU), from creation until deletion. A cluster cannot be deleted
 * until 4 hours after it was created, so a delete issued earlier blocks
 * (and retries) until then. Creating a cluster can take an hour or more.
 * Do not create one in a short-lived stage.
 * :::
 *
 * :::caution[Changing `name`, `location`, `supportsScaling`, `zoneRedundant`, or `resourceGroup` replaces the cluster]
 * Alchemy creates a new cluster, then deletes the old one. You pay for both
 * clusters until the old one is gone (at least 4 hours after it was
 * created).
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-dedicated-overview
 *
 * ### Creating a Cluster
 * **Example:** One-CU scalable cluster hosting a namespace
 * ```typescript
 * const cluster = yield* Azure.EventHub.Cluster("dedicated", {
 *   capacity: 1,
 *   supportsScaling: true,
 * });
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   sku: "Premium",
 *   clusterArmId: cluster.clusterId,
 * });
 * ```
 *
 * @resource
 */
export const Cluster = GroupedResource<Cluster>("Azure.EventHub.Cluster");

type ObservedCluster = eventhub.GetClusterResponse;

const getCluster = (subscriptionId: string, resourceGroupName: string, clusterName: string) =>
  orUndefinedIfNotFound(eventhub.GetCluster({ subscriptionId, resourceGroupName, clusterName }));

const lower = (value: string | undefined) => value?.toLowerCase().replace(/\s/g, "");

/** Clusters report `Active` (or `Succeeded`) once usable. */
const readiness = (cluster: ObservedCluster) => {
  const state = cluster.properties?.provisioningState;
  return state === "Active" ? "Succeeded" : state;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster | eventhub.Cluster,
): Cluster["Attributes"] => ({
  clusterName: name,
  clusterId: cluster.id ?? "",
  resourceGroup,
  location: cluster.location ?? "",
  capacity: cluster.sku?.capacity,
  supportsScaling: cluster.properties?.supportsScaling,
  zoneRedundant: cluster.properties?.zoneRedundant,
  metricId: cluster.properties?.metricId,
  status: cluster.properties?.status,
  tags: userTags(cluster.tags),
});

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "clusterId", "resourceGroup", "location", "metricId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventhub.ListClusterBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) && group !== undefined && cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.clusterName)) ||
        (news.location !== undefined && lower(news.location) !== lower(output.location)) ||
        (news.supportsScaling !== undefined &&
          news.supportsScaling !== (output.supportsScaling ?? false)) ||
        (news.zoneRedundant !== undefined && news.zoneRedundant !== (output.zoneRedundant ?? false))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name = output?.clusterName ?? olds?.name ?? (yield* createNamespaceName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.clusterName ?? (yield* createNamespaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = { name: "Dedicated", capacity: news.capacity ?? 1 };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `event hubs cluster ${name}`;
      // Dedicated clusters can take over an hour to provision.
      const waitReady = waitForProvisioned(
        label,
        getCluster(subscriptionId, resourceGroup, name),
        readiness,
        { interval: "30 seconds", times: 150 },
      );

      // Observe.
      let observed = yield* getCluster(subscriptionId, resourceGroup, name);

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* eventhub.ClustersCreateOrUpdate({
          ...where,
          location,
          sku,
          tags,
          properties: {
            supportsScaling: news.supportsScaling,
            zoneRedundant: news.zoneRedundant,
          },
        });
      }
      observed = yield* waitReady;

      // Sync capacity and tags against observed state; PATCH deltas.
      const capacityChanged = (observed.sku?.capacity ?? 1) !== sku.capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (capacityChanged || tagsChanged) {
        yield* eventhub.UpdateCluster({
          ...where,
          sku: capacityChanged ? sku : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        // The PATCH is applied asynchronously: the cluster can still read
        // back Active with the previous tags/capacity right after it.
        observed = yield* waitForProvisioned(
          label,
          getCluster(subscriptionId, resourceGroup, name),
          (cluster) => {
            const state = readiness(cluster);
            if (state !== undefined && state !== "Succeeded") return state;
            return (cluster.sku?.capacity ?? 1) === sku.capacity && !tagsDiffer(cluster.tags, tags)
              ? "Succeeded"
              : "Updating";
          },
          { interval: "10 seconds", times: 90 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A cluster cannot be deleted until 4 hours after it was created;
      // retry the typed refusal until that minimum has elapsed (~4h15m).
      yield* ignoreNotFound(
        eventhub.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      ).pipe(
        Effect.tapError((e) =>
          e._tag === "EventHubClusterDeleteTooSoon"
            ? Effect.logInfo(
                `event hubs cluster ${output.clusterName} is younger than 4 hours; retrying delete`,
              )
            : Effect.void,
        ),
        Effect.retry({
          while: (e) => e._tag === "EventHubClusterDeleteTooSoon",
          schedule: Schedule.spaced("3 minutes"),
          times: 85,
        }),
      );
      yield* waitUntilGone(
        `event hubs cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "30 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
