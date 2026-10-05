import * as aks from "@distilled.cloud/azure/hybridaks";
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
import {
  HYBRID_AKS_NAMESPACE,
  type HybridAksExtendedLocation,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

/** An inclusive IPv4 address range (`startIP`-`endIP`). */
export interface VirtualNetworkIpPool {
  /** First IP address of the pool. */
  startIP: string;
  /** Last IP address of the pool. */
  endIP: string;
}

/** The Microsoft On-premises Cloud (MOC) network an AKS Arc network maps onto. */
export interface VirtualNetworkHciProfile {
  /** Group in MOC (Microsoft On-premises Cloud). */
  mocGroup?: string;
  /** Location in MOC (Microsoft On-premises Cloud). */
  mocLocation?: string;
  /** Name of the virtual network in MOC (Microsoft On-premises Cloud). */
  mocVnetName?: string;
}

export interface VirtualNetworkProps {
  /** Resource group the network is created in. Changing it replaces the network. */
  resourceGroup: string;
  /**
   * Name of the network. If omitted, a unique lowercase name is generated
   * from the app, stage, and logical ID. Changing it replaces the network.
   */
  name?: string;
  /**
   * Azure region of the network; must match the custom location's region.
   * Changing it replaces the network.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the network.
   * Changing it replaces the network.
   */
  extendedLocation: HybridAksExtendedLocation;
  /**
   * The MOC virtual network on the Azure Local cluster this network
   * represents. Changing it replaces the network.
   */
  hci?: VirtualNetworkHciProfile;
  /**
   * IP ranges for the Kubernetes API server and `LoadBalancer` services
   * (when using the HA Proxy load balancer). Changing them replaces the
   * network.
   */
  vipPool?: VirtualNetworkIpPool[];
  /**
   * IP ranges for the Kubernetes node VMs (static IP networks). Changing
   * them replaces the network.
   */
  vmipPool?: VirtualNetworkIpPool[];
  /** DNS server IP addresses. Changing them replaces the network. */
  dnsServers?: string[];
  /** Gateway IP address of the network. Changing it replaces the network. */
  gateway?: string;
  /**
   * Address prefix of the network in CIDR notation, e.g. `10.0.0.0/24`.
   * Changing it replaces the network.
   */
  ipAddressPrefix?: string;
  /** VLAN ID of the network. Changing it replaces the network. */
  vlanID?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualNetwork extends Resource<
  "Azure.HybridContainerService.VirtualNetwork",
  VirtualNetworkProps,
  {
    /** Name of the network. */
    virtualNetworkName: string;
    /** Resource group that holds the network. */
    resourceGroup: string;
    /** ARM resource ID of the network. */
    virtualNetworkId: string;
    /** Azure region of the network. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the network. */
    customLocationId: string | undefined;
    /** Provisioning state of the network. */
    provisioningState: string | undefined;
    /** Status of the latest operation on the network. */
    operationStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AKS Arc virtual network (`Microsoft.HybridContainerService/virtualNetworks`):
 * the IP configuration (VIP pool, node IP pool, DNS, gateway, VLAN) that AKS
 * clusters on an Azure Local (Azure Stack HCI) cluster use for their node
 * VMs and load balancers. Needs an Arc custom location backed by the Arc
 * Resource Bridge of a deployed Azure Local cluster.
 *
 * This is the legacy AKS hybrid network object; current Azure Local
 * deployments use `Azure.AzureStackHCI.LogicalNetwork` and reference it from
 * `Azure.HybridContainerService.ProvisionedCluster` via `vnetSubnetIds`.
 *
 * @see https://learn.microsoft.com/azure/aks/hybrid/aks-networks
 *
 * ### Creating a Network
 * **Example:** Static IP network with a VIP pool
 * ```typescript
 * const network = yield* Azure.HybridContainerService.VirtualNetwork("aks-net", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   hci: { mocGroup: "target-group", mocLocation: "MocLocation", mocVnetName: "vnet1" },
 *   ipAddressPrefix: "10.0.0.0/24",
 *   gateway: "10.0.0.1",
 *   dnsServers: ["10.0.0.2"],
 *   vipPool: [{ startIP: "10.0.0.200", endIP: "10.0.0.220" }],
 *   vmipPool: [{ startIP: "10.0.0.100", endIP: "10.0.0.150" }],
 * });
 * ```
 *
 * **Example:** Tagged network on a VLAN
 * ```typescript
 * yield* Azure.HybridContainerService.VirtualNetwork("vlan-net", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   hci: { mocVnetName: "vlan100" },
 *   vlanID: 100,
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetwork = Resource<VirtualNetwork>(
  "Azure.HybridContainerService.VirtualNetwork",
);

const SPEC_KEYS = [
  "hci",
  "vipPool",
  "vmipPool",
  "dnsServers",
  "gateway",
  "ipAddressPrefix",
  "vlanID",
] as const;

const getVirtualNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualNetworkName: string,
) =>
  orUndefinedIfNotFound(
    aks.GetVirtualNetwork({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
    }),
  );

const createName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true, delimiter: "-" });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: aks.GetVirtualNetworkResponse,
): VirtualNetwork["Attributes"] => ({
  virtualNetworkName: name,
  resourceGroup,
  virtualNetworkId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  provisioningState: value.properties?.provisioningState,
  operationStatus: value.properties?.status?.operationStatus?.status,
  tags: userTags(value.tags),
});

const WAIT = { interval: "10 seconds", times: 60 } as const;

export const VirtualNetworkProvider = () =>
  Provider.succeed(VirtualNetwork, {
    stables: [
      "virtualNetworkName",
      "resourceGroup",
      "virtualNetworkId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        aks
          .ListVirtualNetworkBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListVirtualNetworkBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) &&
          group !== undefined &&
          value.name !== undefined
          ? [toAttrs(group, value.name, value)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.virtualNetworkName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined &&
          SPEC_KEYS.some((key) => !sameValue(news[key], olds[key])))
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
        output?.virtualNetworkName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getVirtualNetwork(
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
      yield* ensureRegistered(subscriptionId, HYBRID_AKS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.virtualNetworkName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualNetworkName: name,
      };
      const get = getVirtualNetwork(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `AKS Arc virtual network ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        WAIT,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Everything but tags is immutable (diff replaces), so the
      // PUT only runs when the network is missing.
      if (observed === undefined) {
        yield* aks.VirtualNetworksCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            infraVnetProfile:
              news.hci === undefined ? undefined : { hci: news.hci },
            vipPool: news.vipPool,
            vmipPool: news.vmipPool,
            dnsServers: news.dnsServers,
            gateway: news.gateway,
            ipAddressPrefix: news.ipAddressPrefix,
            vlanID: news.vlanID,
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed network.
      if (tagsDiffer(observed.tags, tags)) {
        yield* aks.UpdateVirtualNetwork({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aks.DeleteVirtualNetwork({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualNetworkName: output.virtualNetworkName,
        }),
      );
      yield* waitUntilGone(
        `AKS Arc virtual network ${output.virtualNetworkName}`,
        getVirtualNetwork(
          subscriptionId,
          output.resourceGroup,
          output.virtualNetworkName,
        ),
        WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
