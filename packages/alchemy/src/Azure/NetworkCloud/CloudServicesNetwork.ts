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
  customLocation,
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  propertyDelta,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";

export interface CloudServicesNetworkProps {
  /**
   * Resource group the cloud services network is created in. Changing it replaces the
   * cloud services network.
   */
  resourceGroup: string;
  /**
   * Name of the cloud services network. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the cloud services network.
   */
  name?: string;
  /**
   * Azure location of the cloud services network; must match the location of the Nexus
   * cluster. Changing it replaces the cloud services network.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the cloud services network.
   */
  customLocationId: string;
  /** Extra egress endpoints (by category) the network may reach. */
  additionalEgressEndpoints?: nc.EgressEndpoint[];
  /**
   * Allow egress to the platform's default endpoints (`True`/`False`).
   * @default "False"
   */
  enableDefaultEgressEndpoints?: "True" | "False";
  /** Shared storage options for workloads on the network. */
  storageOptions?: nc.CloudServicesNetworkStorageOptions;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CloudServicesNetwork extends Resource<
  "Azure.NetworkCloud.CloudServicesNetwork",
  CloudServicesNetworkProps,
  {
    /** Name of the cloud services network. */
    cloudServicesNetworkName: string;
    /** ARM resource ID of the cloud services network. */
    cloudServicesNetworkId: string;
    /** Resource group that holds the cloud services network. */
    resourceGroup: string;
    /** Location of the cloud services network. */
    location: string;
    /** Custom location the cloud services network is deployed to. */
    customLocationId: string | undefined;
    /** Egress endpoints the network can reach. */
    enabledEgressEndpoints: nc.EgressEndpoint[];
    /** Interface name on attached virtual machines. */
    interfaceName: string | undefined;
    /** ARM ID of the Nexus cluster the network is associated with. */
    clusterId: string | undefined;
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
 * An Azure Operator Nexus cloud services network — the network that gives
 * Nexus virtual machines and Kubernetes clusters DNS, NTP, and proxied
 * egress to allow-listed endpoints. Needs a deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/quickstarts-tenant-workload-prerequisites
 *
 * ### Creating a Cloud Services Network
 * **Example:** Egress to the default endpoints plus one extra
 * ```typescript
 * const csn = yield* Azure.NetworkCloud.CloudServicesNetwork("csn", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   enableDefaultEgressEndpoints: "True",
 *   additionalEgressEndpoints: [
 *     {
 *       category: "registry",
 *       endpoints: [{ domainName: "ghcr.io", port: 443 }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const CloudServicesNetwork = Resource<CloudServicesNetwork>(
  "Azure.NetworkCloud.CloudServicesNetwork",
);

type Observed = nc.GetCloudServicesNetworkResponse;

const getCloudServicesNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetCloudServicesNetwork({
      subscriptionId,
      resourceGroupName,
      cloudServicesNetworkName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): CloudServicesNetwork["Attributes"] => {
  const p = observed.properties;
  return {
    cloudServicesNetworkName: name,
    cloudServicesNetworkId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    enabledEgressEndpoints: [...(p?.enabledEgressEndpoints ?? [])],
    interfaceName: p?.interfaceName,
    clusterId: p?.clusterId,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const CloudServicesNetworkProvider = () =>
  Provider.succeed(CloudServicesNetwork, {
    stables: [
      "cloudServicesNetworkName",
      "cloudServicesNetworkId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListCloudServicesNetworkBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCloudServicesNetworkBySubscription", page),
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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.cloudServicesNetworkName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId)
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
        output?.cloudServicesNetworkName ??
        olds?.name ??
        (yield* createNexusName(id, 63));
      const observed = yield* getCloudServicesNetwork(
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
        output?.cloudServicesNetworkName ??
        (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        cloudServicesNetworkName: name,
      };
      const label = `Nexus cloud services network ${name}`;
      const get = getCloudServicesNetwork(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.CloudServicesNetworksCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            additionalEgressEndpoints: news.additionalEgressEndpoints,
            enableDefaultEgressEndpoints: news.enableDefaultEgressEndpoints,
            storageOptions: news.storageOptions,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        additionalEgressEndpoints: news.additionalEgressEndpoints,
        enableDefaultEgressEndpoints: news.enableDefaultEgressEndpoints,
        storageOptions: news.storageOptions,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* nc.UpdateCloudServicesNetwork({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.cloudServicesNetworkName;
      yield* ignoreNotFound(
        nc.DeleteCloudServicesNetwork({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          cloudServicesNetworkName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus cloud services network ${name}`,
        getCloudServicesNetwork(subscriptionId, output.resourceGroup, name),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
