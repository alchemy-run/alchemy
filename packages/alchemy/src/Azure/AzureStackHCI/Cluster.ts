import * as hci from "@distilled.cloud/azure/azurestackhci";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { HCI_NAMESPACE, sameId } from "./Common.ts";

export interface ClusterDesiredProperties {
  /**
   * Whether Windows Server guest licensing through the cluster's Azure
   * subscription is enabled.
   */
  windowsServerSubscription?: "Disabled" | "Enabled";
  /** Level of diagnostic data the cluster sends to Microsoft. */
  diagnosticLevel?: "Off" | "Basic" | "Enhanced";
}

export interface ClusterProps {
  /** Resource group the cluster record is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Name of the cluster record. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure region of the cluster record. Only Azure Local regions are
   * accepted (e.g. `eastus`, `westeurope`, `australiaeast`). Changing it
   * replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Purpose of the cluster deployment, e.g. `AzureLocal`. Changing it
   * replaces the cluster.
   */
  kind?: string;
  /**
   * Managed identity of the cluster record.
   * @default "SystemAssigned"
   */
  identity?: "SystemAssigned" | "None";
  /** App (client) ID of the cluster's Microsoft Entra identity. */
  aadClientId?: string;
  /** Tenant ID of the cluster's Microsoft Entra identity. */
  aadTenantId?: string;
  /**
   * Object ID of the cluster's Microsoft Entra application. Changing it
   * replaces the cluster.
   */
  aadApplicationObjectId?: string;
  /**
   * Object ID of the cluster identity's service principal. Changing it
   * replaces the cluster.
   */
  aadServicePrincipalObjectId?: string;
  /** Endpoint configured for management from the Azure portal. */
  cloudManagementEndpoint?: string;
  /** Desired cluster settings (diagnostics, Windows Server subscription). */
  desiredProperties?: ClusterDesiredProperties;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.AzureStackHCI.Cluster",
  ClusterProps,
  {
    /** Name of the cluster record. */
    clusterName: string;
    /** Resource group that holds the cluster record. */
    resourceGroup: string;
    /** ARM resource ID of the cluster record. */
    clusterId: string;
    /** Azure region of the cluster record. */
    location: string;
    /** Purpose of the cluster deployment, if set. */
    kind: string | undefined;
    /** Unique, immutable cluster ID used by on-premises nodes to register. */
    cloudId: string;
    /**
     * Registration status, e.g. `NotYetRegistered` until physical nodes
     * register against the record, then `ConnectedRecently` etc.
     */
    status: string;
    /** Connectivity of the on-premises cluster to Azure. */
    connectivityStatus: string;
    /** Object ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant ID of the cluster's Microsoft Entra identity. */
    aadTenantId: string | undefined;
    /** App (client) ID of the cluster's Microsoft Entra identity. */
    aadClientId: string | undefined;
    /** Endpoint configured for management from the Azure portal. */
    cloudManagementEndpoint: string | undefined;
    /** Desired cluster settings as observed. */
    desiredProperties: {
      /** Windows Server subscription setting. */
      windowsServerSubscription: string | undefined;
      /** Diagnostic data level. */
      diagnosticLevel: string | undefined;
    };
    /** Azure Local service endpoint of the region. */
    serviceEndpoint: string | undefined;
    /** Object ID of the Azure Local resource provider's service principal. */
    resourceProviderObjectId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * The Azure-side record of an Azure Local (formerly Azure Stack HCI)
 * cluster. On-premises nodes register against it with its `cloudId`; until
 * then it stays `NotYetRegistered` and is not billed.
 *
 * @see https://learn.microsoft.com/azure/azure-local/overview
 *
 * ### Creating a Cluster Record
 * **Example:** Cluster record with a system-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge", {
 *   location: "eastus",
 * });
 * const cluster = yield* Azure.AzureStackHCI.Cluster("site-a", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Configuring Diagnostics
 * **Example:** Enhanced diagnostics and Windows Server subscription
 * ```typescript
 * const cluster = yield* Azure.AzureStackHCI.Cluster("site-a", {
 *   resourceGroup: group.resourceGroupName,
 *   desiredProperties: {
 *     diagnosticLevel: "Enhanced",
 *     windowsServerSubscription: "Enabled",
 *   },
 *   tags: { site: "a" },
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.AzureStackHCI.Cluster");

type ObservedCluster = hci.GetClusterResponse;

export const getHciCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetCluster({ subscriptionId, resourceGroupName, clusterName }),
  );

const createClusterName = (id: string) =>
  createPhysicalName({ id, maxLength: 40 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): Cluster["Attributes"] => ({
  clusterName: name,
  resourceGroup,
  clusterId: cluster.id ?? "",
  location: cluster.location,
  kind: cluster.kind,
  cloudId: cluster.properties?.cloudId ?? "",
  status: cluster.properties?.status ?? "",
  connectivityStatus: cluster.properties?.connectivityStatus ?? "",
  principalId: cluster.identity?.principalId,
  aadTenantId: cluster.properties?.aadTenantId,
  aadClientId: cluster.properties?.aadClientId,
  cloudManagementEndpoint: cluster.properties?.cloudManagementEndpoint,
  desiredProperties: {
    windowsServerSubscription:
      cluster.properties?.desiredProperties?.windowsServerSubscription,
    diagnosticLevel: cluster.properties?.desiredProperties?.diagnosticLevel,
  },
  serviceEndpoint: cluster.properties?.serviceEndpoint,
  resourceProviderObjectId: cluster.properties?.resourceProviderObjectId,
  tags: userTags(cluster.tags),
});

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "clusterName",
      "resourceGroup",
      "clusterId",
      "location",
      "cloudId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        hci
          .ListClusterBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListClusterBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.clusterName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (olds !== undefined &&
          (news.kind !== olds.kind ||
            news.aadApplicationObjectId !== olds.aadApplicationObjectId ||
            news.aadServicePrincipalObjectId !==
              olds.aadServicePrincipalObjectId))
      ) {
        // An explicit name is reused by the replacement, so the old one
        // must go first; generated names differ per instance.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getHciCluster(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identityType = news.identity ?? "SystemAssigned";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const get = getHciCluster(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is synchronous for the registration record.
      if (observed === undefined) {
        yield* hci.CreateCluster({
          ...where,
          location,
          kind: news.kind,
          tags,
          identity: { type: identityType },
          properties: {
            aadClientId: news.aadClientId,
            aadTenantId: news.aadTenantId,
            aadApplicationObjectId: news.aadApplicationObjectId,
            aadServicePrincipalObjectId: news.aadServicePrincipalObjectId,
            cloudManagementEndpoint: news.cloudManagementEndpoint,
            desiredProperties: news.desiredProperties,
          },
        });
        observed = yield* waitForProvisioned(
          `Azure Local cluster ${name}`,
          get,
          (cluster) => cluster.properties?.provisioningState,
        );
      }

      // Sync the mutable aspects against the observed record.
      const props = observed.properties;
      const properties: hci.ClusterPatchProperties = {};
      if (
        news.aadClientId !== undefined &&
        !sameId(news.aadClientId, props?.aadClientId)
      ) {
        properties.aadClientId = news.aadClientId;
      }
      if (
        news.aadTenantId !== undefined &&
        !sameId(news.aadTenantId, props?.aadTenantId)
      ) {
        properties.aadTenantId = news.aadTenantId;
      }
      if (
        news.cloudManagementEndpoint !== undefined &&
        news.cloudManagementEndpoint !== props?.cloudManagementEndpoint
      ) {
        properties.cloudManagementEndpoint = news.cloudManagementEndpoint;
      }
      const desired = news.desiredProperties;
      if (
        desired !== undefined &&
        ((desired.diagnosticLevel !== undefined &&
          desired.diagnosticLevel !==
            props?.desiredProperties?.diagnosticLevel) ||
          (desired.windowsServerSubscription !== undefined &&
            desired.windowsServerSubscription !==
              props?.desiredProperties?.windowsServerSubscription))
      ) {
        properties.desiredProperties = {
          ...props?.desiredProperties,
          ...desired,
        };
      }
      const identityChanged =
        (observed.identity?.type ?? "None") !== identityType;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        Object.keys(properties).length > 0 ||
        identityChanged ||
        tagsChanged
      ) {
        yield* hci.UpdateCluster({
          ...where,
          ...(tagsChanged ? { tags } : {}),
          ...(identityChanged ? { identity: { type: identityType } } : {}),
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
        });
        observed = yield* waitForProvisioned(
          `Azure Local cluster ${name}`,
          get,
          (cluster) => cluster.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local cluster ${output.clusterName}`,
        getHciCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
