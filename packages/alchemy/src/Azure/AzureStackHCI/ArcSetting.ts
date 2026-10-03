import * as hci from "@distilled.cloud/azure/azurestackhci";
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
import { getHciCluster } from "./Cluster.ts";
import {
  HCI_NAMESPACE,
  isStackOwnedTags,
  sameId,
  sameValue,
} from "./Common.ts";

export interface ArcServiceConfiguration {
  /** Service reachable through Arc connectivity, e.g. `WAC` (Windows Admin Center). */
  serviceName: "WAC" | (string & {});
  /** Port the service listens on. */
  port: number;
}

export interface ArcConnectivity {
  /** Whether connectivity to the cluster's services through Arc is enabled. */
  enabled?: boolean;
  /** Services exposed through Arc connectivity. */
  serviceConfigurations?: ArcServiceConfiguration[];
}

export interface ArcSettingProps {
  /** Resource group of the cluster. Changing it replaces the Arc setting. */
  resourceGroup: string;
  /** Name of the parent cluster record. Changing it replaces the Arc setting. */
  cluster: string;
  /**
   * Name of the Arc setting. Changing it replaces the Arc setting.
   * @default "default"
   */
  name?: string;
  /**
   * Resource group that holds the Arc-enabled server resources of the
   * cluster's nodes. Pass an existing group: when omitted, Azure tries to
   * create `<cluster>-<cloudId>-Arc-Infra-RG`, which requires the resource
   * provider to hold subscription-level rights. Changing it replaces the
   * Arc setting.
   */
  arcInstanceResourceGroup?: string;
  /** App (client) ID of the Arc Microsoft Entra application. */
  arcApplicationClientId?: string;
  /** Tenant ID of the Arc Microsoft Entra application. */
  arcApplicationTenantId?: string;
  /** Object ID of the Arc application's service principal. */
  arcServicePrincipalObjectId?: string;
  /** Object ID of the Arc Microsoft Entra application. */
  arcApplicationObjectId?: string;
  /** Connectivity to the cluster's services through Arc. */
  connectivityProperties?: ArcConnectivity;
}

export interface ArcSetting extends Resource<
  "Azure.AzureStackHCI.ArcSetting",
  ArcSettingProps,
  {
    /** Name of the Arc setting. */
    arcSettingName: string;
    /** Name of the parent cluster record. */
    clusterName: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the Arc setting. */
    arcSettingId: string;
    /** Resource group that holds the nodes' Arc-enabled server resources. */
    arcInstanceResourceGroup: string | undefined;
    /** Aggregate Arc agent state across the cluster's nodes. */
    aggregateState: string | undefined;
    /** App (client) ID of the Arc Microsoft Entra application. */
    arcApplicationClientId: string | undefined;
    /** Tenant ID of the Arc Microsoft Entra application. */
    arcApplicationTenantId: string | undefined;
    /** Object ID of the Arc application's service principal. */
    arcServicePrincipalObjectId: string | undefined;
    /** Object ID of the Arc Microsoft Entra application. */
    arcApplicationObjectId: string | undefined;
    /** Whether Arc connectivity to the cluster's services is enabled. */
    connectivityEnabled: boolean;
  },
  never,
  Providers
> {}

/**
 * Arc settings of an Azure Local cluster record: where the nodes'
 * Arc-enabled server resources live, the Arc Microsoft Entra application,
 * and Arc connectivity to cluster services. Extensions are installed under
 * an Arc setting.
 *
 * The Arc setting has no tags; Alchemy treats it as owned when its parent
 * cluster carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/azure-arc-vm-management-overview
 *
 * ### Creating Arc Settings
 * **Example:** Arc settings that keep node resources in the cluster's group
 * ```typescript
 * const cluster = yield* Azure.AzureStackHCI.Cluster("site-a", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const arc = yield* Azure.AzureStackHCI.ArcSetting("arc", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   arcInstanceResourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Arc Connectivity
 * **Example:** Expose Windows Admin Center through Arc
 * ```typescript
 * const arc = yield* Azure.AzureStackHCI.ArcSetting("arc", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   arcInstanceResourceGroup: group.resourceGroupName,
 *   connectivityProperties: {
 *     enabled: true,
 *     serviceConfigurations: [{ serviceName: "WAC", port: 6516 }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ArcSetting = Resource<ArcSetting>(
  "Azure.AzureStackHCI.ArcSetting",
);

export const getHciArcSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  arcSettingName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetArcSettings({
      subscriptionId,
      resourceGroupName,
      clusterName,
      arcSettingName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  arc: hci.GetArcSettingsResponse,
): ArcSetting["Attributes"] => ({
  arcSettingName: name,
  clusterName: cluster,
  resourceGroup,
  arcSettingId: arc.id ?? "",
  arcInstanceResourceGroup: arc.properties?.arcInstanceResourceGroup,
  aggregateState: arc.properties?.aggregateState,
  arcApplicationClientId: arc.properties?.arcApplicationClientId,
  arcApplicationTenantId: arc.properties?.arcApplicationTenantId,
  arcServicePrincipalObjectId: arc.properties?.arcServicePrincipalObjectId,
  arcApplicationObjectId: arc.properties?.arcApplicationObjectId,
  connectivityEnabled: arc.properties?.connectivityProperties?.enabled ?? false,
});

const identityFields = [
  "arcApplicationClientId",
  "arcApplicationTenantId",
  "arcServicePrincipalObjectId",
  "arcApplicationObjectId",
] as const;

export const ArcSettingProvider = () =>
  Provider.succeed(ArcSetting, {
    stables: ["arcSettingName", "clusterName", "resourceGroup", "arcSettingId"],

    // Arc settings are removed with their cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.cluster, output.clusterName) ||
        !sameId(news.name ?? "default", output.arcSettingName) ||
        (news.arcInstanceResourceGroup !== undefined &&
          !sameId(
            news.arcInstanceResourceGroup,
            output.arcInstanceResourceGroup,
          ))
      ) {
        // The name is fixed per parent, so the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.clusterName ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name = output?.arcSettingName ?? olds?.name ?? "default";
      const observed = yield* getHciArcSetting(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      const parent = yield* getHciCluster(
        subscriptionId,
        resourceGroup,
        cluster,
      );
      return (yield* isStackOwnedTags(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { resourceGroup, cluster } = news;
      const name = news.name ?? "default";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        arcSettingName: name,
      };
      const get = getHciArcSetting(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      const settle = waitForProvisioned(
        `Arc setting ${cluster}/${name}`,
        get,
        (arc) => arc.properties?.provisioningState,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT also carries the Arc application identity, so a
      // drifted identity is converged with the same upsert.
      const identityDrift = identityFields.some(
        (field) =>
          news[field] !== undefined &&
          !sameId(news[field], observed?.properties?.[field]),
      );
      if (observed === undefined || identityDrift) {
        yield* hci.CreateArcSettings({
          ...where,
          properties: {
            arcInstanceResourceGroup:
              news.arcInstanceResourceGroup ??
              observed?.properties?.arcInstanceResourceGroup,
            arcApplicationClientId: news.arcApplicationClientId,
            arcApplicationTenantId: news.arcApplicationTenantId,
            arcServicePrincipalObjectId: news.arcServicePrincipalObjectId,
            arcApplicationObjectId: news.arcApplicationObjectId,
            connectivityProperties: news.connectivityProperties,
          },
        });
        observed = yield* settle;
      }

      // Sync Arc connectivity against the observed setting.
      const desired = news.connectivityProperties;
      const current = observed.properties?.connectivityProperties;
      if (
        desired !== undefined &&
        ((desired.enabled !== undefined &&
          desired.enabled !== (current?.enabled ?? false)) ||
          (desired.serviceConfigurations !== undefined &&
            !sameValue(
              desired.serviceConfigurations,
              current?.serviceConfigurations ?? [],
            )))
      ) {
        yield* hci.UpdateArcSettings({
          ...where,
          properties: {
            connectivityProperties: {
              enabled: desired.enabled ?? current?.enabled,
              serviceConfigurations:
                desired.serviceConfigurations ?? current?.serviceConfigurations,
            },
          },
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteArcSettings({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
          arcSettingName: output.arcSettingName,
        }),
      );
      yield* waitUntilGone(
        `Arc setting ${output.clusterName}/${output.arcSettingName}`,
        getHciArcSetting(
          subscriptionId,
          output.resourceGroup,
          output.clusterName,
          output.arcSettingName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
