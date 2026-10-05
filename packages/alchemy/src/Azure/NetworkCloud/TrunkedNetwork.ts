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
  inSync,
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";

export interface TrunkedNetworkProps {
  /**
   * Resource group the trunked network is created in. Changing it replaces the
   * trunked network.
   */
  resourceGroup: string;
  /**
   * Name of the trunked network. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the trunked network.
   */
  name?: string;
  /**
   * Azure location of the trunked network; must match the location of the Nexus
   * cluster. Changing it replaces the trunked network.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the trunked network.
   */
  customLocationId: string;
  /**
   * ARM IDs of the Network Fabric L2/L3 isolation domains the network
   * trunks. Changing them replaces the trunked network.
   */
  isolationDomainIds: string[];
  /** VLANs carried by the trunk. Changing them replaces the trunked network. */
  vlans: number[];
  /**
   * Interface name of the network on attached virtual machines. Changing it
   * replaces the trunked network.
   */
  interfaceName?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface TrunkedNetwork extends Resource<
  "Azure.NetworkCloud.TrunkedNetwork",
  TrunkedNetworkProps,
  {
    /** Name of the trunked network. */
    trunkedNetworkName: string;
    /** ARM resource ID of the trunked network. */
    trunkedNetworkId: string;
    /** Resource group that holds the trunked network. */
    resourceGroup: string;
    /** Location of the trunked network. */
    location: string;
    /** Custom location the trunked network is deployed to. */
    customLocationId: string | undefined;
    /** ARM IDs of the trunked isolation domains. */
    isolationDomainIds: string[];
    /** VLANs carried by the trunk. */
    vlans: number[];
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
 * An Azure Operator Nexus trunked network — a VLAN trunk over one or more
 * Network Fabric isolation domains, attached to Nexus virtual machines and
 * Kubernetes clusters. Needs a deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/quickstarts-tenant-workload-prerequisites
 *
 * ### Creating a Trunked Network
 * **Example:** Trunk two VLANs
 * ```typescript
 * const trunk = yield* Azure.NetworkCloud.TrunkedNetwork("trunk", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   isolationDomainIds: [l2Domain.l2IsolationDomainId],
 *   vlans: [500, 501],
 * });
 * ```
 *
 * @resource
 */
export const TrunkedNetwork = Resource<TrunkedNetwork>(
  "Azure.NetworkCloud.TrunkedNetwork",
);

type Observed = nc.GetTrunkedNetworkResponse;

const getTrunkedNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetTrunkedNetwork({
      subscriptionId,
      resourceGroupName,
      trunkedNetworkName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): TrunkedNetwork["Attributes"] => {
  const p = observed.properties;
  return {
    trunkedNetworkName: name,
    trunkedNetworkId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    isolationDomainIds: [...p.isolationDomainIds],
    vlans: [...p.vlans],
    interfaceName: p.interfaceName,
    clusterId: p.clusterId,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const TrunkedNetworkProvider = () =>
  Provider.succeed(TrunkedNetwork, {
    stables: [
      "trunkedNetworkName",
      "trunkedNetworkId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListTrunkedNetworkBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListTrunkedNetworkBySubscription", page),
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
          !sameArm(news.name, output.trunkedNetworkName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        !inSync(output.isolationDomainIds, news.isolationDomainIds) ||
        !inSync(output.vlans, news.vlans) ||
        (news.interfaceName !== undefined &&
          news.interfaceName !== output.interfaceName)
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
        output?.trunkedNetworkName ??
        olds?.name ??
        (yield* createNexusName(id, 63));
      const observed = yield* getTrunkedNetwork(
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
        output?.trunkedNetworkName ??
        (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        trunkedNetworkName: name,
      };
      const label = `Nexus trunked network ${name}`;
      const get = getTrunkedNetwork(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.TrunkedNetworksCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            isolationDomainIds: news.isolationDomainIds,
            vlans: news.vlans,
            interfaceName: news.interfaceName,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (tagsChanged) {
        yield* nc.UpdateTrunkedNetwork({
          ...where,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.trunkedNetworkName;
      yield* ignoreNotFound(
        nc.DeleteTrunkedNetwork({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          trunkedNetworkName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus trunked network ${name}`,
        getTrunkedNetwork(subscriptionId, output.resourceGroup, name),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
