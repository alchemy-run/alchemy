import * as kusto from "@distilled.cloud/azure/azure_kusto";
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
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  sameId,
  whileClusterBusy,
} from "./common.ts";

export interface ManagedPrivateEndpointProps {
  /** Resource group of the cluster. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the endpoint. */
  cluster: string;
  /**
   * Endpoint name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * ARM resource ID of the target resource (e.g. an Event Hubs namespace or
   * storage account). Changing it replaces the endpoint.
   */
  privateLinkResourceId: string;
  /**
   * Region of the target resource. Changing it replaces the endpoint.
   * @default the target resource's region
   */
  privateLinkResourceRegion?: string;
  /**
   * Private-link sub-resource (group ID) of the target, e.g. `namespace`
   * for Event Hubs or `blob` for storage. Changing it replaces the endpoint.
   */
  groupId: string;
  /**
   * Message shown to the target's owner in the approval request. Azure
   * accepts but never applies changes to it, so changing it replaces the
   * endpoint.
   */
  requestMessage?: string;
}

export interface ManagedPrivateEndpoint extends Resource<
  "Azure.Kusto.ManagedPrivateEndpoint",
  ManagedPrivateEndpointProps,
  {
    /** Name of the managed private endpoint. */
    managedPrivateEndpointName: string;
    /** ARM resource ID of the managed private endpoint. */
    managedPrivateEndpointId: string;
    /** Cluster that owns the endpoint. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Target resource ARM ID. */
    privateLinkResourceId: string;
    /** Target sub-resource. */
    groupId: string;
    /** Approval request message. */
    requestMessage: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A managed private endpoint from an Azure Data Explorer (Kusto) cluster
 * to another Azure resource (Event Hubs, IoT Hub, Storage, ...), so
 * ingestion reaches the source over a private link. The target resource's
 * owner must approve the resulting private endpoint connection.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/security-network-managed-private-endpoint-create
 *
 * ### Private Ingestion
 * **Example:** Managed private endpoint to an Event Hubs namespace
 * ```typescript
 * const endpoint = yield* Azure.Kusto.ManagedPrivateEndpoint("events", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   privateLinkResourceId: namespace.namespaceId,
 *   groupId: "namespace",
 *   requestMessage: "Kusto ingestion",
 * });
 * ```
 *
 * @resource
 */
export const ManagedPrivateEndpoint = Resource<ManagedPrivateEndpoint>(
  "Azure.Kusto.ManagedPrivateEndpoint",
);

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  managedPrivateEndpointName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetManagedPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      clusterName,
      managedPrivateEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  endpoint: kusto.GetManagedPrivateEndpointResponse,
): ManagedPrivateEndpoint["Attributes"] => ({
  managedPrivateEndpointName: name,
  managedPrivateEndpointId: endpoint.id ?? "",
  cluster,
  resourceGroup,
  privateLinkResourceId: endpoint.properties?.privateLinkResourceId ?? "",
  groupId: endpoint.properties?.groupId ?? "",
  requestMessage: endpoint.properties?.requestMessage,
});

export const ManagedPrivateEndpointProvider = () =>
  Provider.succeed(ManagedPrivateEndpoint, {
    stables: [
      "managedPrivateEndpointName",
      "managedPrivateEndpointId",
      "cluster",
      "resourceGroup",
      "privateLinkResourceId",
      "groupId",
    ],

    // Endpoints live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.cluster !== output.cluster ||
        (news.name !== undefined &&
          news.name !== output.managedPrivateEndpointName) ||
        !sameId(news.privateLinkResourceId, output.privateLinkResourceId) ||
        lower(news.groupId) !== lower(output.groupId) ||
        (olds !== undefined &&
          (lower(news.privateLinkResourceRegion)?.replace(/\s/g, "") !==
            lower(olds.privateLinkResourceRegion)?.replace(/\s/g, "") ||
            news.requestMessage !== olds.requestMessage))
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
        output?.managedPrivateEndpointName ??
        olds?.name ??
        (yield* createKustoChildName(id));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return output !== undefined ||
        (yield* isClusterOwnedByStack(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ??
        output?.managedPrivateEndpointName ??
        (yield* createKustoChildName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        managedPrivateEndpointName: name,
      };
      const properties: kusto.ManagedPrivateEndpointProperties = {
        privateLinkResourceId: news.privateLinkResourceId,
        privateLinkResourceRegion: news.privateLinkResourceRegion,
        groupId: news.groupId,
        requestMessage: news.requestMessage,
      };
      const get = getEndpoint(subscriptionId, resourceGroup, cluster, name);
      const waitReady = waitForProvisioned(
        `kusto managed private endpoint ${name}`,
        get,
        (e) => e.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* kusto
          .ManagedPrivateEndpointsCreateOrUpdate({ ...where, properties })
          .pipe(Effect.retry(whileClusterBusy));
      }
      // Every property is immutable (diff replaces), so there is nothing
      // to sync.
      observed = yield* waitReady;

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteManagedPrivateEndpoint({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.cluster,
            managedPrivateEndpointName: output.managedPrivateEndpointName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `kusto managed private endpoint ${output.managedPrivateEndpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.managedPrivateEndpointName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
