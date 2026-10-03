import * as network from "@distilled.cloud/azure/network";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createNetworkName,
  peeringInput,
  ref,
  sameId,
  sameSet,
  subnetInput,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface VirtualNetworkEncryptionSettings {
  /** Whether VNet encryption is enabled. */
  enabled: boolean;
  /**
   * Whether VMs without encryption support may join the encrypted VNet.
   * @default "AllowUnencrypted"
   */
  enforcement?: "DropUnencrypted" | "AllowUnencrypted";
}

export interface VirtualNetworkProps {
  /**
   * Resource group the virtual network is created in. Changing it replaces
   * the virtual network.
   */
  resourceGroup: string;
  /**
   * Name of the virtual network: 2-64 letters, digits, `_`, `.`, and `-`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the virtual network.
   */
  name?: string;
  /**
   * Azure location of the virtual network. Changing it replaces the
   * virtual network.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Address space in CIDR notation, e.g. `["10.0.0.0/16"]`. Prefixes can be
   * added in place; removing one that a subnet uses fails.
   */
  addressPrefixes: string[];
  /**
   * Custom DNS servers for VMs in the virtual network.
   * @default Azure-provided DNS
   */
  dnsServers?: string[];
  /**
   * Flow timeout in minutes (4-30) for connections in the virtual network.
   * @default disabled
   */
  flowTimeoutInMinutes?: number;
  /**
   * ARM ID of a DDoS protection plan. Setting it enables DDoS Network
   * Protection on the virtual network (billed ~$2,944/month per plan).
   */
  ddosProtectionPlanId?: string;
  /**
   * Enable VM protection for all subnets.
   * @default false
   */
  enableVmProtection?: boolean;
  /** Virtual network encryption settings. */
  encryption?: VirtualNetworkEncryptionSettings;
  /**
   * Private endpoint VNet policies.
   * @default "Disabled"
   */
  privateEndpointVNetPolicies?: "Disabled" | "Basic";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualNetwork extends Resource<
  "Azure.Network.VirtualNetwork",
  VirtualNetworkProps,
  {
    /** Name of the virtual network. */
    virtualNetworkName: string;
    /** ARM resource ID of the virtual network. */
    virtualNetworkId: string;
    /** Resource group that holds the virtual network. */
    resourceGroup: string;
    /** Location of the virtual network. */
    location: string;
    /** Immutable GUID Azure assigned to the virtual network. */
    resourceGuid: string | undefined;
    /** Address space in CIDR notation. */
    addressPrefixes: string[];
    /** Custom DNS servers (empty when using Azure-provided DNS). */
    dnsServers: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual network (VNet) — an isolated private network that
 * Subnets, network interfaces, private endpoints, and load balancers live
 * in.
 *
 * Subnets are modelled by `Azure.Network.Subnet`; updating the virtual
 * network never removes them.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-networks-overview
 *
 * ### Creating a Virtual Network
 * **Example:** VNet with a /16 address space
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * ```
 *
 * **Example:** VNet with custom DNS servers
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16", "10.1.0.0/16"],
 *   dnsServers: ["10.0.0.4", "10.0.0.5"],
 * });
 * ```
 *
 * ### Adding Subnets
 * **Example:** VNet with a subnet
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetwork = Resource<VirtualNetwork>(
  "Azure.Network.VirtualNetwork",
);

type Observed = network.GetVirtualNetworkResponse;

const getVnet = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualNetworkName: string,
) =>
  orUndefinedIfNotFound(
    network.GetVirtualNetwork({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  vnet: Observed,
): VirtualNetwork["Attributes"] => ({
  virtualNetworkName: name,
  virtualNetworkId: vnet.id ?? "",
  resourceGroup,
  location: vnet.location ?? "",
  resourceGuid: vnet.properties?.resourceGuid,
  addressPrefixes: [...(vnet.properties?.addressSpace?.addressPrefixes ?? [])],
  dnsServers: [...(vnet.properties?.dhcpOptions?.dnsServers ?? [])],
  tags: userTags(vnet.tags),
});

export const VirtualNetworkProvider = () =>
  Provider.succeed(VirtualNetwork, {
    stables: [
      "virtualNetworkName",
      "virtualNetworkId",
      "resourceGroup",
      "location",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListVirtualNetworkAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVirtualNetworkAll", page),
          ),
        );
      return page.value.flatMap((vnet) => {
        const group = resourceGroupOf(vnet.id);
        return hasAnyAlchemyTag(vnet.tags) &&
          group !== undefined &&
          vnet.name !== undefined
          ? [toAttrs(group, vnet.name, vnet)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.virtualNetworkName)) ||
        (news.location !== undefined && !sameId(news.location, output.location))
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
        output?.virtualNetworkName ??
        olds?.name ??
        (yield* createNetworkName(id, 64));
      const observed = yield* getVnet(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.virtualNetworkName ??
        (yield* createNetworkName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualNetworkName: name,
      };
      const label = `virtual network ${name}`;
      const get = getVnet(subscriptionId, resourceGroup, name);
      const desired = {
        addressSpace: { addressPrefixes: news.addressPrefixes },
        dhcpOptions: { dnsServers: news.dnsServers ?? [] },
        flowTimeoutInMinutes: news.flowTimeoutInMinutes,
        enableDdosProtection: news.ddosProtectionPlanId !== undefined,
        ddosProtectionPlan: ref(news.ddosProtectionPlanId),
        enableVmProtection: news.enableVmProtection ?? false,
        encryption: news.encryption,
        privateEndpointVNetPolicies:
          news.privateEndpointVNetPolicies ?? "Disabled",
      };

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the subnet and peering collections,
      // so it always carries the observed ones (modelled as Subnet /
      // peering resources) instead of dropping them.
      const props = observed?.properties;
      const propsDiffer =
        observed === undefined ||
        !sameSet(props?.addressSpace?.addressPrefixes, news.addressPrefixes) ||
        !sameSet(props?.dhcpOptions?.dnsServers, news.dnsServers) ||
        (news.flowTimeoutInMinutes !== undefined &&
          props?.flowTimeoutInMinutes !== news.flowTimeoutInMinutes) ||
        (props?.enableDdosProtection ?? false) !==
          desired.enableDdosProtection ||
        !sameId(props?.ddosProtectionPlan?.id, news.ddosProtectionPlanId) ||
        (props?.enableVmProtection ?? false) !== desired.enableVmProtection ||
        (news.encryption !== undefined &&
          canonical(props?.encryption) !==
            canonical({
              enforcement: "AllowUnencrypted",
              ...news.encryption,
            })) ||
        (props?.privateEndpointVNetPolicies ?? "Disabled") !==
          desired.privateEndpointVNetPolicies;
      if (propsDiffer) {
        // Each attempt re-reads subnets and peerings: a busy retry with a
        // stale copy would revert a concurrent Subnet / peering write.
        yield* Effect.gen(function* () {
          const current = (yield* get)?.properties;
          yield* network.VirtualNetworksCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              ...desired,
              subnets: current?.subnets?.map(subnetInput),
              virtualNetworkPeerings:
                current?.virtualNetworkPeerings?.map(peeringInput),
            },
          });
        }).pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed?.tags, tags)) {
        yield* network
          .UpdateVirtualNetworkTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(label, get);
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteVirtualNetwork({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualNetworkName: output.virtualNetworkName,
        }),
      ).pipe(Effect.retry(whileInUse(["SubnetInUse"])));
      yield* waitNetworkGone(
        `virtual network ${output.virtualNetworkName}`,
        getVnet(
          subscriptionId,
          output.resourceGroup,
          output.virtualNetworkName,
        ),
      );
    }),

    // Delete VNets (and their subnets) before the NSGs, route tables, and
    // NAT gateways the subnets reference.
    nuke: {
      dependsOn: [
        "Azure.Network.NetworkSecurityGroup",
        "Azure.Network.RouteTable",
        "Azure.Network.NatGateway",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
