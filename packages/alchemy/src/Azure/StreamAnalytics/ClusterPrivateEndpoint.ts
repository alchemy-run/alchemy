import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  clusterOwnedByStage,
  createStreamAnalyticsName,
  lower,
  checkResourceGroup,
} from "./Common.ts";

export interface ClusterPrivateEndpointProps {
  /**
   * Resource group of the cluster. Changing it replaces the private
   * endpoint.
   */
  resourceGroup: string;
  /** Name of the Stream Analytics cluster. Changing it replaces the private endpoint. */
  cluster: string;
  /**
   * Private endpoint name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the private endpoint.
   */
  name?: string;
  /**
   * ARM ID of the target resource, e.g. an Event Hubs namespace or storage
   * account. Changing it replaces the private endpoint.
   */
  privateLinkServiceId: string;
  /**
   * Sub-resource(s) of the target to connect to, e.g. `["namespace"]` for
   * Event Hubs or `["blob"]` for storage. Changing them replaces the
   * private endpoint.
   */
  groupIds: string[];
}

export interface ClusterPrivateEndpoint extends Resource<
  "Azure.StreamAnalytics.ClusterPrivateEndpoint",
  ClusterPrivateEndpointProps,
  {
    /** Name of the private endpoint. */
    privateEndpointName: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the private endpoint. */
    privateEndpointId: string;
    /** Target resource ARM ID. */
    privateLinkServiceId: string;
    /** Target sub-resources. */
    groupIds: string[];
    /**
     * Approval state of the connection on the target resource:
     * `Pending` until the target's owner approves it, then `Approved`.
     */
    connectionStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A managed private endpoint from a dedicated Stream Analytics cluster to
 * a resource in a virtual network (Event Hubs, Storage, SQL, Cosmos DB, ...).
 *
 * The connection stays `Pending` until it is approved on the target
 * resource (its private endpoint connections). The endpoint carries no
 * tags; Alchemy treats it as owned when its cluster carries this stack's
 * and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/stream-analytics/private-endpoints
 *
 * ### Connecting a Cluster to a Private Resource
 * **Example:** Private endpoint to an Event Hubs namespace
 * ```typescript
 * const cluster = yield* Azure.StreamAnalytics.Cluster("dedicated", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.StreamAnalytics.ClusterPrivateEndpoint(
 *   "events",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     cluster: cluster.clusterName,
 *     privateLinkServiceId: namespace.namespaceId,
 *     groupIds: ["namespace"],
 *   },
 * );
 * ```
 *
 * @resource
 */
export const ClusterPrivateEndpoint = Resource<ClusterPrivateEndpoint>(
  "Azure.StreamAnalytics.ClusterPrivateEndpoint",
);

const getPrivateEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  privateEndpointName: string,
) =>
  orUndefinedIfNotFound(
    streamanalytics.GetPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      clusterName,
      privateEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  endpoint: streamanalytics.GetPrivateEndpointResponse,
): ClusterPrivateEndpoint["Attributes"] => {
  const connection =
    endpoint.properties?.manualPrivateLinkServiceConnections?.[0]?.properties;
  return {
    privateEndpointName: name,
    cluster,
    resourceGroup,
    privateEndpointId: endpoint.id ?? "",
    privateLinkServiceId: connection?.privateLinkServiceId ?? "",
    groupIds: connection?.groupIds ?? [],
    connectionStatus: connection?.privateLinkServiceConnectionState?.status,
  };
};

export const ClusterPrivateEndpointProvider = () =>
  Provider.succeed(ClusterPrivateEndpoint, {
    stables: [
      "privateEndpointName",
      "cluster",
      "resourceGroup",
      "privateEndpointId",
      "privateLinkServiceId",
      "groupIds",
    ],

    // Private endpoints live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cluster) !== lower(output.cluster) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.privateEndpointName)) ||
        lower(news.privateLinkServiceId) !==
          lower(output.privateLinkServiceId) ||
        [...news.groupIds].map(lower).sort().join(",") !==
          [...output.groupIds].map(lower).sort().join(",")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.privateEndpointName ??
        olds?.name ??
        (yield* createStreamAnalyticsName(id));
      const observed = yield* getPrivateEndpoint(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* clusterOwnedByStage(
        subscriptionId,
        resourceGroup,
        cluster,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StreamAnalytics");
      const { resourceGroup, cluster } = news;
      yield* checkResourceGroup(resourceGroup);
      const name =
        news.name ??
        output?.privateEndpointName ??
        (yield* createStreamAnalyticsName(id));
      const get = getPrivateEndpoint(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );

      // Observe. Every property is immutable (diff replaces), so there is
      // nothing to sync once the endpoint exists.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* streamanalytics.PrivateEndpointsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          privateEndpointName: name,
          properties: {
            manualPrivateLinkServiceConnections: [
              {
                properties: {
                  privateLinkServiceId: news.privateLinkServiceId,
                  groupIds: news.groupIds,
                },
              },
            ],
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `stream analytics private endpoint ${name}`,
        get,
        () => undefined,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        streamanalytics.DeletePrivateEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          privateEndpointName: output.privateEndpointName,
        }),
      );
      yield* waitUntilGone(
        `stream analytics private endpoint ${output.privateEndpointName}`,
        getPrivateEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.privateEndpointName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
