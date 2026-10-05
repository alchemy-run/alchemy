import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
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
  createFabricName,
  FABRIC_NAMESPACE,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface NetworkPacketBrokerProps {
  /**
   * Resource group the network packet broker is created in. Changing it
   * replaces the network packet broker.
   */
  resourceGroup: string;
  /**
   * Name of the network packet broker. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the network
   * packet broker.
   */
  name?: string;
  /**
   * Azure location of the network packet broker. Changing it replaces the
   * network packet broker. Network Fabric resources are offered in `eastus`,
   * `southcentralus`, `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and
   * `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Network Fabric whose NPB devices the broker manages.
   * Changing it replaces the network packet broker.
   */
  networkFabricId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkPacketBroker extends Resource<
  "Azure.ManagedNetworkFabric.NetworkPacketBroker",
  NetworkPacketBrokerProps,
  {
    /** Name of the network packet broker. */
    networkPacketBrokerName: string;
    /** ARM resource ID of the network packet broker. */
    networkPacketBrokerId: string;
    /** Resource group that holds the network packet broker. */
    resourceGroup: string;
    /** Location of the network packet broker. */
    location: string;
    /** ARM ID of the Network Fabric. */
    networkFabricId: string;
    /** ARM IDs of the NPB network devices. */
    networkDeviceIds: string[];
    /** Interfaces across NPB devices that mirror source traffic. */
    sourceInterfaceIds: string[];
    /** Network taps configured on the broker. */
    networkTapIds: string[];
    /** Neighbor groups configured on the broker. */
    neighborGroupIds: string[];
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus network packet broker — the logical owner of a
 * Network Fabric's packet-broker (NPB) devices, which mirror traffic to
 * `NetworkTap` destinations.
 *
 * The resource provider creates packet brokers itself when a Network Fabric
 * with NPB devices is provisioned and rejects a user PUT (`Network Packet
 * Broker resource PUT not allowed`). Manage an existing broker by passing
 * its `name` and adopting it; Alchemy then syncs its tags, and deleting the
 * resource deletes the broker.
 *
 * @see https://learn.microsoft.com/rest/api/managednetworkfabric/network-packet-brokers
 *
 * ### Managing a Network Packet Broker
 * **Example:** Tag the fabric's packet broker
 * ```typescript
 * const broker = yield* Azure.ManagedNetworkFabric.NetworkPacketBroker("npb", {
 *   resourceGroup: "nexus",
 *   name: "fab1-npb",
 *   networkFabricId:
 *     "/subscriptions/.../resourceGroups/nexus/providers/Microsoft.ManagedNetworkFabric/networkFabrics/fab1",
 *   tags: { team: "network" },
 * }).pipe(AdoptPolicy.adopt());
 * ```
 *
 * ### Tapping Traffic
 * **Example:** Network tap on the broker
 * ```typescript
 * const tap = yield* Azure.ManagedNetworkFabric.NetworkTap("tap", {
 *   resourceGroup: "nexus",
 *   networkPacketBrokerId: broker.networkPacketBrokerId,
 *   destinations: [
 *     {
 *       name: "collectors",
 *       destinationType: "Direct",
 *       destinationId: collectors.neighborGroupId,
 *       destinationTapRuleId: rule.networkTapRuleId,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NetworkPacketBroker = Resource<NetworkPacketBroker>(
  "Azure.ManagedNetworkFabric.NetworkPacketBroker",
);

type Observed = mnf.GetNetworkPacketBrokerResponse;

const getNetworkPacketBroker = (
  subscriptionId: string,
  resourceGroupName: string,
  networkPacketBrokerName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNetworkPacketBroker({
      subscriptionId,
      resourceGroupName,
      networkPacketBrokerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NetworkPacketBroker["Attributes"] => {
  const p = observed.properties;
  return {
    networkPacketBrokerName: name,
    networkPacketBrokerId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    networkFabricId: p?.networkFabricId ?? "",
    networkDeviceIds: [...(p?.networkDeviceIds ?? [])],
    sourceInterfaceIds: [...(p?.sourceInterfaceIds ?? [])],
    networkTapIds: [...(p?.networkTapIds ?? [])],
    neighborGroupIds: [...(p?.neighborGroupIds ?? [])],
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    tags: userTags(observed.tags),
  };
};

export const NetworkPacketBrokerProvider = () =>
  Provider.succeed(NetworkPacketBroker, {
    stables: [
      "networkPacketBrokerName",
      "networkPacketBrokerId",
      "resourceGroup",
      "location",
      "networkFabricId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListNetworkPacketBrokerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkPacketBrokerBySubscription", page),
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
          !sameArm(news.name, output.networkPacketBrokerName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.networkFabricId, output.networkFabricId)
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
        output?.networkPacketBrokerName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getNetworkPacketBroker(
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
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.networkPacketBrokerName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkPacketBrokerName: name,
      };
      const label = `network packet broker ${name}`;
      const get = getNetworkPacketBroker(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNetworkPacketBroker({
          ...where,
          location,
          tags,
          properties: { networkFabricId: news.networkFabricId },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync tags (the only mutable aspect) against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* mnf.UpdateNetworkPacketBroker({ ...where, tags });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `network packet broker ${output.networkPacketBrokerName}`;
      const get = getNetworkPacketBroker(
        subscriptionId,
        output.resourceGroup,
        output.networkPacketBrokerName,
      );
      yield* ignoreNotFound(
        mnf.DeleteNetworkPacketBroker({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          networkPacketBrokerName: output.networkPacketBrokerName,
        }),
      );
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
