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
  lower,
  ref,
  sameId,
  sameSet,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface NetworkInterfaceIpConfiguration {
  /**
   * Name of the IP configuration.
   * @default `ipconfig{n}` (1-based position)
   */
  name?: string;
  /** ARM ID of the subnet the address is allocated from. */
  subnetId: string;
  /**
   * Static private IP address. When set, allocation is `Static`.
   * @default a dynamically allocated address
   */
  privateIpAddress?: string;
  /**
   * Private IP version.
   * @default "IPv4"
   */
  privateIpAddressVersion?: "IPv4" | "IPv6";
  /** ARM ID of a public IP address to associate. */
  publicIpAddressId?: string;
  /**
   * Whether this is the primary IP configuration. Exactly one configuration
   * is primary.
   * @default true for the first configuration
   */
  primary?: boolean;
  /** ARM IDs of application security groups the configuration joins. */
  applicationSecurityGroupIds?: string[];
  /** ARM IDs of load balancer backend address pools to join. */
  loadBalancerBackendAddressPoolIds?: string[];
  /** ARM IDs of load balancer inbound NAT rules to attach. */
  loadBalancerInboundNatRuleIds?: string[];
}

export interface NetworkInterfaceProps {
  /**
   * Resource group the network interface is created in. Changing it
   * replaces the network interface.
   */
  resourceGroup: string;
  /**
   * Name of the network interface: 1-80 letters, digits, `_`, `.`, and
   * `-`. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the network interface.
   */
  name?: string;
  /**
   * Azure location; must match the virtual network's. Changing it replaces
   * the network interface.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** IP configurations. The first one is primary unless stated otherwise. */
  ipConfigurations: NetworkInterfaceIpConfiguration[];
  /** ARM ID of a network security group to associate. */
  networkSecurityGroupId?: string;
  /**
   * DNS servers for the interface.
   * @default inherited from the virtual network
   */
  dnsServers?: string[];
  /** Internal DNS name label for name resolution inside the VNet. */
  internalDnsNameLabel?: string;
  /**
   * Enable accelerated networking (requires a supported VM size).
   * @default false
   */
  enableAcceleratedNetworking?: boolean;
  /**
   * Allow the interface to forward traffic not addressed to it (NVAs).
   * @default false
   */
  enableIpForwarding?: boolean;
  /**
   * Disable TCP connection state tracking.
   * @default false
   */
  disableTcpStateTracking?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkInterface extends Resource<
  "Azure.Network.NetworkInterface",
  NetworkInterfaceProps,
  {
    /** Name of the network interface. */
    networkInterfaceName: string;
    /** ARM resource ID of the network interface. */
    networkInterfaceId: string;
    /** Resource group that holds the network interface. */
    resourceGroup: string;
    /** Location of the network interface. */
    location: string;
    /** MAC address (assigned once attached to a running VM). */
    macAddress: string | undefined;
    /** Private IP address of the primary IP configuration. */
    privateIpAddress: string | undefined;
    /** Private IP addresses of all IP configurations, in order. */
    privateIpAddresses: string[];
    /** ID of the VM the interface is attached to, if any. */
    virtualMachineId: string | undefined;
    /** Associated network security group ID. */
    networkSecurityGroupId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure network interface (NIC) — connects a VM to a subnet with one or
 * more private IP configurations, optionally with public IPs, application
 * security groups, and load balancer pool membership.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-network-network-interface
 *
 * ### Creating a Network Interface
 * **Example:** NIC with a dynamic private IP
 * ```typescript
 * const nic = yield* Azure.Network.NetworkInterface("vm", {
 *   resourceGroup: group.resourceGroupName,
 *   ipConfigurations: [{ subnetId: subnet.subnetId }],
 * });
 * ```
 *
 * **Example:** NIC with a static private IP and a public IP
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("vm", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const nic = yield* Azure.Network.NetworkInterface("vm", {
 *   resourceGroup: group.resourceGroupName,
 *   ipConfigurations: [
 *     {
 *       subnetId: subnet.subnetId,
 *       privateIpAddress: "10.0.1.10",
 *       publicIpAddressId: ip.publicIpAddressId,
 *     },
 *   ],
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * ```
 *
 * @resource
 */
export const NetworkInterface = Resource<NetworkInterface>(
  "Azure.Network.NetworkInterface",
);

type Observed = network.GetNetworkInterfaceResponse;

const getNic = (
  subscriptionId: string,
  resourceGroupName: string,
  networkInterfaceName: string,
) =>
  orUndefinedIfNotFound(
    network.GetNetworkInterface({
      subscriptionId,
      resourceGroupName,
      networkInterfaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  nic: Observed,
): NetworkInterface["Attributes"] => {
  const configs = nic.properties?.ipConfigurations ?? [];
  const primary =
    configs.find((config) => config.properties?.primary) ?? configs[0];
  return {
    networkInterfaceName: name,
    networkInterfaceId: nic.id ?? "",
    resourceGroup,
    location: nic.location ?? "",
    macAddress: nic.properties?.macAddress || undefined,
    privateIpAddress: primary?.properties?.privateIPAddress,
    privateIpAddresses: configs.flatMap((config) =>
      config.properties?.privateIPAddress === undefined
        ? []
        : [config.properties.privateIPAddress],
    ),
    virtualMachineId: nic.properties?.virtualMachine?.id,
    networkSecurityGroupId: nic.properties?.networkSecurityGroup?.id,
    tags: userTags(nic.tags),
  };
};

const sortedIds = (values: ReadonlyArray<string | undefined> | undefined) =>
  (values ?? [])
    .flatMap((value) => (value === undefined ? [] : [value.toLowerCase()]))
    .sort();

/** Comparable shape of one IP configuration (desired or observed). */
interface ComparableIpConfig {
  name: string;
  subnet: string | undefined;
  allocation: string;
  address: string | undefined;
  version: string;
  publicIp: string | undefined;
  primary: boolean;
  asgs: string[];
  pools: string[];
  natRules: string[];
}

const desiredConfigs = (
  configs: ReadonlyArray<NetworkInterfaceIpConfiguration>,
): ComparableIpConfig[] => {
  const anyPrimary = configs.some((config) => config.primary);
  return configs.map((config, index) => ({
    name: config.name ?? `ipconfig${index + 1}`,
    subnet: lower(config.subnetId),
    allocation: config.privateIpAddress === undefined ? "Dynamic" : "Static",
    address: config.privateIpAddress,
    version: config.privateIpAddressVersion ?? "IPv4",
    publicIp: lower(config.publicIpAddressId),
    primary: anyPrimary ? (config.primary ?? false) : index === 0,
    asgs: sortedIds(config.applicationSecurityGroupIds),
    pools: sortedIds(config.loadBalancerBackendAddressPoolIds),
    natRules: sortedIds(config.loadBalancerInboundNatRuleIds),
  }));
};

const observedConfigs = (nic: Observed): ComparableIpConfig[] =>
  (nic.properties?.ipConfigurations ?? []).map((config) => {
    const p = config.properties;
    const allocation = p?.privateIPAllocationMethod ?? "Dynamic";
    return {
      name: config.name ?? "",
      subnet: lower(p?.subnet?.id),
      allocation,
      address: allocation === "Static" ? p?.privateIPAddress : undefined,
      version: p?.privateIPAddressVersion ?? "IPv4",
      publicIp: lower(p?.publicIPAddress?.id),
      primary: p?.primary ?? false,
      asgs: sortedIds(p?.applicationSecurityGroups?.map((asg) => asg.id)),
      pools: sortedIds(
        p?.loadBalancerBackendAddressPools?.map((pool) => pool.id),
      ),
      natRules: sortedIds(
        p?.loadBalancerInboundNatRules?.map((rule) => rule.id),
      ),
    };
  });

export const NetworkInterfaceProvider = () =>
  Provider.succeed(NetworkInterface, {
    stables: [
      "networkInterfaceName",
      "networkInterfaceId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListNetworkInterfaceAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkInterfaceAll", page),
          ),
        );
      return page.value.flatMap((nic) => {
        const group = resourceGroupOf(nic.id);
        return hasAnyAlchemyTag(nic.tags) &&
          group !== undefined &&
          nic.name !== undefined
          ? [toAttrs(group, nic.name, nic)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.networkInterfaceName)) ||
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
        output?.networkInterfaceName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* getNic(subscriptionId, resourceGroup, name);
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
        output?.networkInterfaceName ??
        (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkInterfaceName: name,
      };
      const get = getNic(subscriptionId, resourceGroup, name);
      const configs = desiredConfigs(news.ipConfigurations);

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync. The PUT is a full replacement of the interface's
      // configuration, so it is sent only when an aspect drifts.
      const differs =
        observed === undefined ||
        canonical(observedConfigs(observed)) !== canonical(configs) ||
        !sameId(props?.networkSecurityGroup?.id, news.networkSecurityGroupId) ||
        !sameSet(props?.dnsSettings?.dnsServers, news.dnsServers) ||
        (news.internalDnsNameLabel !== undefined &&
          props?.dnsSettings?.internalDnsNameLabel !==
            news.internalDnsNameLabel) ||
        (props?.enableAcceleratedNetworking ?? false) !==
          (news.enableAcceleratedNetworking ?? false) ||
        (props?.enableIPForwarding ?? false) !==
          (news.enableIpForwarding ?? false) ||
        (props?.disableTcpStateTracking ?? false) !==
          (news.disableTcpStateTracking ?? false);
      if (differs) {
        yield* network
          .NetworkInterfacesCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              networkSecurityGroup: ref(news.networkSecurityGroupId),
              dnsSettings: {
                dnsServers: news.dnsServers ?? [],
                internalDnsNameLabel: news.internalDnsNameLabel,
              },
              enableAcceleratedNetworking:
                news.enableAcceleratedNetworking ?? false,
              enableIPForwarding: news.enableIpForwarding ?? false,
              disableTcpStateTracking: news.disableTcpStateTracking ?? false,
              ipConfigurations: news.ipConfigurations.map((config, index) => ({
                name: configs[index]!.name,
                properties: {
                  subnet: { id: config.subnetId },
                  privateIPAllocationMethod: configs[index]!.allocation,
                  privateIPAddress: config.privateIpAddress,
                  privateIPAddressVersion: configs[index]!.version,
                  publicIPAddress: ref(config.publicIpAddressId),
                  primary: configs[index]!.primary,
                  applicationSecurityGroups:
                    config.applicationSecurityGroupIds?.map((id) => ({ id })),
                  loadBalancerBackendAddressPools:
                    config.loadBalancerBackendAddressPoolIds?.map((id) => ({
                      id,
                    })),
                  loadBalancerInboundNatRules:
                    config.loadBalancerInboundNatRuleIds?.map((id) => ({
                      id,
                    })),
                },
              })),
            },
          })
          .pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed?.tags, tags)) {
        yield* network
          .UpdateNetworkInterfaceTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(
        `network interface ${name}`,
        get,
      );
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteNetworkInterface({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          networkInterfaceName: output.networkInterfaceName,
        }),
      ).pipe(Effect.retry(whileInUse(["NetworkInterfaceInUse"])));
      yield* waitNetworkGone(
        `network interface ${output.networkInterfaceName}`,
        getNic(
          subscriptionId,
          output.resourceGroup,
          output.networkInterfaceName,
        ),
      );
    }),

    // Delete NICs before the subnets, NSGs, public IPs, and load balancers
    // they reference.
    nuke: {
      dependsOn: [
        "Azure.Network.LoadBalancer",
        "Azure.Network.VirtualNetwork",
        "Azure.Network.Subnet",
        "Azure.Network.NetworkSecurityGroup",
        "Azure.Network.PublicIpAddress",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
