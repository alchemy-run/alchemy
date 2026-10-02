import * as nc from "@distilled.cloud/azure/networkcloud";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNexusName,
  differs,
  identityBody,
  identityInSync,
  NEXUS_NAMESPACE,
  NEXUS_SLOW_BUDGET,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";
import type {
  NexusIdentity,
  NexusManagedResourceGroupConfiguration,
} from "./Types.ts";

export interface ClusterManagerProps {
  /**
   * Resource group the cluster manager is created in. Changing it replaces the
   * cluster manager.
   */
  resourceGroup: string;
  /**
   * Name of the cluster manager. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the cluster manager.
   */
  name?: string;
  /**
   * Azure location of the cluster manager; must match the location of the Nexus
   * network fabric controller. Changing it replaces the cluster manager.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Network Fabric controller the manager is paired with.
   * Changing it replaces the cluster manager.
   */
  fabricControllerId: string;
  /**
   * ARM ID of the Log Analytics workspace that receives manager logs.
   * Changing it replaces the cluster manager.
   */
  analyticsWorkspaceId?: string;
  /**
   * Availability zones of the manager's infrastructure. Changing them
   * replaces the cluster manager.
   */
  availabilityZones?: string[];
  /**
   * Name and location of the managed resource group the manager creates.
   * Changing it replaces the cluster manager.
   */
  managedResourceGroupConfiguration?: NexusManagedResourceGroupConfiguration;
  /** VM size of the manager's infrastructure. Changing it replaces the cluster manager. */
  vmSize?: string;
  /**
   * Deployment kind: `Nexus` or `AzureLocal`. Changing it replaces the
   * cluster manager.
   * @default "Nexus"
   */
  kind?: "Nexus" | "AzureLocal";
  /** Managed identity of the cluster manager. */
  identity?: NexusIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ClusterManager extends Resource<
  "Azure.NetworkCloud.ClusterManager",
  ClusterManagerProps,
  {
    /** Name of the cluster manager. */
    clusterManagerName: string;
    /** ARM resource ID of the cluster manager. */
    clusterManagerId: string;
    /** Resource group that holds the cluster manager. */
    resourceGroup: string;
    /** Location of the cluster manager. */
    location: string;
    /** ARM ID of the paired Network Fabric controller. */
    fabricControllerId: string;
    /** Custom location that clusters managed by this manager use. */
    managerCustomLocationId: string | undefined;
    /** Cluster versions the manager can deploy. */
    clusterVersions: string[];
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus cluster manager — the Azure-hosted control plane
 * that deploys and lifecycles Nexus clusters on on-premises racks. It is
 * paired with a Network Fabric controller and takes tens of minutes to
 * provision. Needs an Operator Nexus-onboarded subscription.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-cluster-manager
 *
 * ### Creating a Cluster Manager
 * **Example:** Manager paired with a fabric controller
 * ```typescript
 * const manager = yield* Azure.NetworkCloud.ClusterManager("manager", {
 *   resourceGroup: group.resourceGroupName,
 *   fabricControllerId: controller.networkFabricControllerId,
 *   analyticsWorkspaceId: workspace.workspaceId,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const ClusterManager = Resource<ClusterManager>(
  "Azure.NetworkCloud.ClusterManager",
);

type Observed = nc.GetClusterManagerResponse;

const getClusterManager = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetClusterManager({
      subscriptionId,
      resourceGroupName,
      clusterManagerName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): ClusterManager["Attributes"] => {
  const p = observed.properties;
  return {
    clusterManagerName: name,
    clusterManagerId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    fabricControllerId: p.fabricControllerId,
    managerCustomLocationId: p.managerExtendedLocation?.name,
    clusterVersions: (p.clusterVersions ?? []).flatMap((version) =>
      version.targetClusterVersion === undefined
        ? []
        : [version.targetClusterVersion],
    ),
    principalId: observed.identity?.principalId,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const ClusterManagerProvider = () =>
  Provider.succeed(ClusterManager, {
    stables: [
      "clusterManagerName",
      "clusterManagerId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListClusterManagerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListClusterManagerBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.clusterManagerName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.fabricControllerId, output.fabricControllerId) ||
        (olds !== undefined &&
          (!sameArm(news.analyticsWorkspaceId, olds.analyticsWorkspaceId) ||
            differs(news.availabilityZones, olds.availabilityZones) ||
            differs(
              news.managedResourceGroupConfiguration,
              olds.managedResourceGroupConfiguration,
            ) ||
            !sameArm(news.vmSize, olds.vmSize) ||
            !sameArm(news.kind ?? "Nexus", olds.kind ?? "Nexus")))
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
        output?.clusterManagerName ??
        olds?.name ??
        (yield* createNexusName(id, 63));
      const observed = yield* getClusterManager(
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
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.clusterManagerName ??
        (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterManagerName: name,
      };
      const label = `Nexus cluster manager ${name}`;
      const get = getClusterManager(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.ClusterManagersCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: identityBody(news.identity),
          kind: news.kind ?? "Nexus",
          properties: {
            fabricControllerId: news.fabricControllerId,
            analyticsWorkspaceId: news.analyticsWorkspaceId,
            availabilityZones: news.availabilityZones,
            managedResourceGroupConfiguration:
              news.managedResourceGroupConfiguration,
            vmSize: news.vmSize,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const identityChanged = !identityInSync(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (identityChanged || tagsChanged) {
        yield* nc.UpdateClusterManager({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identityBody(news.identity) : undefined,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.clusterManagerName;
      yield* ignoreNotFound(
        nc.DeleteClusterManager({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterManagerName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus cluster manager ${name}`,
        getClusterManager(subscriptionId, output.resourceGroup, name),
        NEXUS_SLOW_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
