import * as network from "@distilled.cloud/azure/network";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * Whether VNet encryption is enabled. Traffic between VMs on supported
   * sizes is encrypted in transit.
   */
  enabled: boolean;
  /**
   * What happens to traffic from VMs that do not support encryption:
   * `AllowUnencrypted` lets it through unencrypted, `DropUnencrypted`
   * drops it.
   * @default "AllowUnencrypted"
   */
  enforcement?: "DropUnencrypted" | "AllowUnencrypted";
}

export interface VirtualNetworkProps {
  /**
   * Resource group the virtual network is created in. Changing it replaces
   * the virtual network.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
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
   * Address space in CIDR notation, e.g. `["10.0.0.0/16"]`. Add an IPv6
   * range (e.g. `fd00:db8:deca::/48`) for a dual-stack network. Prefixes
   * are added and removed in place; removing one that a subnet uses fails.
   */
  addressPrefixes: string[];
  /**
   * Custom DNS server IPs for VMs in the virtual network. Running VMs pick
   * up a change when they restart. Updated in place.
   * @default Azure-provided DNS
   */
  dnsServers?: string[];
  /**
   * Flow timeout in minutes (4-30) for connections in the virtual network.
   * Updated in place.
   * @default disabled
   */
  flowTimeoutInMinutes?: number;
  /**
   * ARM ID of a DDoS protection plan. Setting it enables DDoS Network
   * Protection on the virtual network (billed ~$2,944/month per plan).
   * Updated in place.
   * @default no DDoS Network Protection
   */
  ddosProtectionPlanId?: string;
  /**
   * Enable VM protection for all subnets.
   * @default false
   */
  enableVmProtection?: boolean;
  /**
   * Virtual network encryption settings. Updated in place.
   * @default encryption disabled
   */
  encryption?: VirtualNetworkEncryptionSettings;
  /**
   * Private endpoint VNet policies (`Microsoft.Network` property
   * `privateEndpointVNetPolicies`). Updated in place.
   * @default "Disabled"
   */
  privateEndpointVNetPolicies?: "Disabled" | "Basic";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
    /** Azure location of the virtual network, e.g. `eastus`. */
    location: string;
    /** Immutable GUID Azure assigned to the virtual network. */
    resourceGuid: string | undefined;
    /** Address space in CIDR notation, as Azure reports it. */
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
 * An Azure virtual network (`Microsoft.Network/virtualNetworks`): an
 * isolated private network in one region, Azure's counterpart to an AWS
 * VPC. Subnets, network interfaces, private endpoints, and internal load
 * balancers live in it.
 *
 * A new virtual network uses Azure-provided DNS and has no subnets and no
 * public entry point. Alchemy registers the `Microsoft.Network` resource
 * provider on the subscription for you. Declare subnets with
 * `Azure.Network.Subnet` and peerings with
 * `Azure.Network.VirtualNetworkPeering`; updating the virtual network
 * never removes them.
 *
 * :::caution[Changing `name`, `location`, or `resourceGroup` replaces the virtual network]
 * Alchemy creates a new, empty network and deletes the old one. The old
 * network cannot be deleted while its subnets hold network interfaces or
 * private endpoints, so plan to replace those resources too. They get new
 * private IPs.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-networks-overview
 *
 * ### Creating a Virtual Network
 * **Example:** VNet with a /16 address space
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * ```
 *
 * **Example:** VNet with a fixed name and region
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   name: "contoso-prod-vnet",
 *   location: "westeurope",
 *   addressPrefixes: ["10.20.0.0/16"],
 *   tags: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Dual-stack IPv4 and IPv6 network
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16", "fd00:db8:deca::/48"],
 * });
 * ```
 *
 * ### Growing the Address Space
 * Add a prefix and deploy. Azure updates the network in place. Removing a
 * prefix fails while a subnet uses addresses from it.
 *
 * **Example:** Add a second range
 * ```diff
 *  const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 * -  addressPrefixes: ["10.0.0.0/16"],
 * +  addressPrefixes: ["10.0.0.0/16", "10.1.0.0/16"],
 *  });
 * ```
 *
 * ### Custom DNS Servers
 * VMs in the network use the servers in `dnsServers`. Running VMs pick up
 * a change when they restart. Remove the prop to go back to Azure DNS.
 *
 * **Example:** Your own DNS servers
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 *   dnsServers: ["10.0.0.4", "10.0.0.5"],
 * });
 * ```
 *
 * **Example:** Resolve a private zone with Azure DNS
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const zone = yield* Azure.PrivateDns.Zone("internal", {
 *   name: "internal.contoso.com",
 * });
 * yield* Azure.PrivateDns.VirtualNetworkLink("vnet-internal", {
 *   privateZoneName: zone.privateZoneName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 *   registrationEnabled: true,
 * });
 * ```
 *
 * ### Adding Subnets
 * Each subnet takes a range inside the address space. Declare sibling
 * subnets side by side; Alchemy retries while Azure writes them one at a
 * time.
 *
 * **Example:** Two subnets, one without default outbound access
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const web = yield* Azure.Network.Subnet("web", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const data = yield* Azure.Network.Subnet("data", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.2.0/24",
 *   defaultOutboundAccess: false,
 * });
 * ```
 *
 * ### Peering Networks
 * A peering is one-way. Create one on each side to connect two networks;
 * their address spaces must not overlap.
 *
 * **Example:** Hub and spoke
 * ```typescript
 * const hub = yield* Azure.Network.VirtualNetwork("hub", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const spoke = yield* Azure.Network.VirtualNetwork("spoke", {
 *   addressPrefixes: ["10.1.0.0/16"],
 * });
 * yield* Azure.Network.VirtualNetworkPeering("hub-to-spoke", {
 *   virtualNetwork: hub.virtualNetworkName,
 *   remoteVirtualNetworkId: spoke.virtualNetworkId,
 * });
 * yield* Azure.Network.VirtualNetworkPeering("spoke-to-hub", {
 *   virtualNetwork: spoke.virtualNetworkName,
 *   remoteVirtualNetworkId: hub.virtualNetworkId,
 * });
 * ```
 *
 * ### Encryption
 * VNet encryption encrypts traffic between VMs that support it.
 * `enforcement` decides what happens to traffic from VMs that do not.
 *
 * **Example:** Encrypt traffic in transit
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 *   encryption: { enabled: true, enforcement: "AllowUnencrypted" },
 * });
 * ```
 *
 * ### DDoS Protection
 * Attach a DDoS protection plan to turn on DDoS Network Protection for
 * the public IPs in the network. One plan (~$2,944/month) covers many
 * networks.
 *
 * **Example:** Protected network
 * ```typescript
 * const plan = yield* Azure.Network.DdosProtectionPlan("ddos");
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 *   ddosProtectionPlanId: plan.ddosProtectionPlanId,
 * });
 * ```
 *
 * ### Flow Timeout and Flow Logs
 * `flowTimeoutInMinutes` keeps idle connections tracked for 4-30
 * minutes. A flow log records every IP flow in the network to a storage
 * account.
 *
 * **Example:** Long-lived connections
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 *   flowTimeoutInMinutes: 30,
 * });
 * ```
 *
 * **Example:** VNet flow log on the Azure-created watcher
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("flowlogs");
 * yield* Azure.Network.FlowLog("vnet", {
 *   resourceGroup: "NetworkWatcherRG",
 *   networkWatcher: "NetworkWatcher_eastus",
 *   targetResourceId: vnet.virtualNetworkId,
 *   storageId: account.storageAccountId,
 *   retentionDays: 7,
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetwork = GroupedResource<VirtualNetwork>("Azure.Network.VirtualNetwork");

type Observed = network.GetVirtualNetworkResponse;

const getVnet = (subscriptionId: string, resourceGroupName: string, virtualNetworkName: string) =>
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
      const page = yield* collectAll(network.ListVirtualNetworkAll, { subscriptionId });
      return page.value.flatMap((vnet) => {
        const group = resourceGroupOf(vnet.id);
        return hasAnyAlchemyTag(vnet.tags) && group !== undefined && vnet.name !== undefined
          ? [toAttrs(group, vnet.name, vnet)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.virtualNetworkName)) ||
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
      const name = output?.virtualNetworkName ?? olds?.name ?? (yield* createNetworkName(id, 64));
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
      const name = news.name ?? output?.virtualNetworkName ?? (yield* createNetworkName(id, 64));
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
        privateEndpointVNetPolicies: news.privateEndpointVNetPolicies ?? "Disabled",
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
        (props?.enableDdosProtection ?? false) !== desired.enableDdosProtection ||
        !sameId(props?.ddosProtectionPlan?.id, news.ddosProtectionPlanId) ||
        (props?.enableVmProtection ?? false) !== desired.enableVmProtection ||
        (news.encryption !== undefined &&
          canonical(props?.encryption) !==
            canonical({
              enforcement: "AllowUnencrypted",
              ...news.encryption,
            })) ||
        (props?.privateEndpointVNetPolicies ?? "Disabled") !== desired.privateEndpointVNetPolicies;
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
              virtualNetworkPeerings: current?.virtualNetworkPeerings?.map(peeringInput),
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
        getVnet(subscriptionId, output.resourceGroup, output.virtualNetworkName),
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
