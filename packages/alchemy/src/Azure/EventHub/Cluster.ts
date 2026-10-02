import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createNamespaceName } from "./Common.ts";

export interface ClusterProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name: 6-50 letters, digits, and hyphens, starting with a letter
   * and ending with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Capacity units (CUs). Changeable in place only when `supportsScaling`
   * is `true`.
   * @default 1
   */
  capacity?: number;
  /**
   * Create a self-serve scalable cluster whose capacity can change after
   * creation. Changing it replaces the cluster.
   */
  supportsScaling?: boolean;
  /**
   * Spread the cluster across availability zones. Changing it replaces the
   * cluster.
   */
  zoneRedundant?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
    /** Capacity units. */
    capacity: number | undefined;
    /** Whether capacity can change after creation. */
    supportsScaling: boolean | undefined;
    /** Whether the cluster is zone redundant. */
    zoneRedundant: boolean | undefined;
    /** Identifier for Azure Monitor metrics. */
    metricId: string | undefined;
    /** Cluster status. */
    status: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dedicated Event Hubs cluster — single-tenant capacity that hosts
 * namespaces (set a namespace's `clusterArmId`).
 *
 * Dedicated clusters bill per capacity unit-hour (several dollars per hour)
 * with a 4-hour minimum: a cluster cannot be deleted until 4 hours after it
 * was created. Provisioning can take an hour or more.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-dedicated-overview
 *
 * ### Creating a Cluster
 * **Example:** One-CU scalable cluster hosting a namespace
 * ```typescript
 * const cluster = yield* Azure.EventHub.Cluster("dedicated", {
 *   resourceGroup: group.resourceGroupName,
 *   capacity: 1,
 *   supportsScaling: true,
 * });
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium",
 *   clusterArmId: cluster.clusterId,
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.EventHub.Cluster");

type ObservedCluster = eventhub.GetClusterResponse;

const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetCluster({ subscriptionId, resourceGroupName, clusterName }),
  );

const lower = (value: string | undefined) =>
  value?.toLowerCase().replace(/\s/g, "");

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
    stables: [
      "clusterName",
      "clusterId",
      "resourceGroup",
      "location",
      "metricId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* eventhub
        .ListClusterBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListClusterBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.clusterName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.supportsScaling !== undefined &&
          news.supportsScaling !== (output.supportsScaling ?? false)) ||
        (news.zoneRedundant !== undefined &&
          news.zoneRedundant !== (output.zoneRedundant ?? false))
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
      const name =
        output?.clusterName ?? olds?.name ?? (yield* createNamespaceName(id));
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
      const name =
        news.name ?? output?.clusterName ?? (yield* createNamespaceName(id));
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
        { interval: "30 seconds", times: 60 },
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
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
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
