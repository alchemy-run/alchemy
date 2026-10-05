import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  checkResourceGroup,
  createStreamAnalyticsName,
  getCluster,
  lower,
} from "./Common.ts";

export interface ClusterProps {
  /**
   * Resource group the cluster is created in, at most 80 characters
   * (Stream Analytics rejects longer names). Changing it replaces the
   * cluster.
   */
  resourceGroup: string;
  /**
   * Cluster name: 3-63 letters, digits, hyphens, and underscores. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Streaming units the cluster provides: a multiple of 36, from 36 up to
   * 396. Scaling changes billing immediately.
   * @default 36
   */
  capacity?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.StreamAnalytics.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster; pass it as a job's `clusterId`. */
    clusterResourceId: string;
    /** Azure-assigned GUID of the cluster. */
    clusterGuid: string | undefined;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** Provisioned streaming units. */
    capacity: number | undefined;
    /** Streaming units currently used by running jobs. */
    capacityAllocated: number | undefined;
    /** Streaming units assigned to all jobs on the cluster. */
    capacityAssigned: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dedicated Azure Stream Analytics cluster — single-tenant capacity for
 * streaming jobs, with private endpoints into virtual networks.
 *
 * A cluster is billed per streaming unit-hour for as long as it exists
 * (36 SU minimum, several dollars per hour), and provisioning takes 30 to
 * 60 minutes.
 *
 * @see https://learn.microsoft.com/azure/stream-analytics/cluster-overview
 *
 * ### Creating a Cluster
 * **Example:** Smallest dedicated cluster
 * ```typescript
 * const cluster = yield* Azure.StreamAnalytics.Cluster("dedicated", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Cluster scaled to 72 streaming units
 * ```typescript
 * const cluster = yield* Azure.StreamAnalytics.Cluster("dedicated", {
 *   resourceGroup: group.resourceGroupName,
 *   capacity: 72,
 *   tags: { team: "analytics" },
 * });
 * ```
 *
 * ### Running Jobs on the Cluster
 * **Example:** Job pinned to the cluster
 * ```typescript
 * const job = yield* Azure.StreamAnalytics.StreamingJob("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   clusterId: cluster.clusterResourceId,
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.StreamAnalytics.Cluster");

type ObservedCluster = streamanalytics.GetClusterResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): Cluster["Attributes"] => ({
  clusterName: name,
  clusterResourceId: cluster.id ?? "",
  clusterGuid: cluster.properties?.clusterId,
  resourceGroup,
  location: cluster.location ?? "",
  capacity: cluster.sku?.capacity,
  capacityAllocated: cluster.properties?.capacityAllocated,
  capacityAssigned: cluster.properties?.capacityAssigned,
  tags: userTags(cluster.tags),
});

/** Provisioning and scaling a cluster takes 30-90 minutes. */
const SLOW = { interval: "30 seconds", times: 180 } as const;

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "clusterResourceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* streamanalytics
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
          lower(news.location) !== lower(output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.clusterName ??
        olds?.name ??
        (yield* createStreamAnalyticsName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StreamAnalytics");
      const resourceGroup = news.resourceGroup;
      yield* checkResourceGroup(resourceGroup);
      const name =
        news.name ??
        output?.clusterName ??
        (yield* createStreamAnalyticsName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const capacity = news.capacity ?? 36;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const get = getCluster(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `stream analytics cluster ${name}`,
        get,
        (cluster) => cluster.properties?.provisioningState,
        SLOW,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* streamanalytics.ClustersCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: { name: "Default", capacity },
          properties: {},
        });
      }
      observed = yield* waitReady;

      // Sync capacity and tags against the observed cluster.
      const capacityChanged = observed.sku?.capacity !== capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (capacityChanged || tagsChanged) {
        yield* streamanalytics.UpdateCluster({
          ...where,
          sku: capacityChanged ? { name: "Default", capacity } : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        streamanalytics.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `stream analytics cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        SLOW,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
