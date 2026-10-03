import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface IpamPoolStaticCidrProps {
  /** Resource group of the network manager. Changing it replaces the CIDR. */
  resourceGroup: string;
  /** Name of the network manager. Changing it replaces the CIDR. */
  networkManager: string;
  /** Name of the parent IPAM pool. Changing it replaces the CIDR. */
  ipamPool: string;
  /**
   * Name of the static CIDR. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the CIDR.
   */
  name?: string;
  /** Description of the reservation. */
  description?: string;
  /**
   * Explicit prefixes to reserve, e.g. `["10.0.5.0/24"]`. Set this or
   * `numberOfIPAddressesToAllocate`. Changing it replaces the CIDR.
   */
  addressPrefixes?: string[];
  /**
   * Number of addresses to reserve (a power of two) when
   * `addressPrefixes` is unset. Changing it replaces the CIDR.
   */
  numberOfIPAddressesToAllocate?: string;
}

export interface IpamPoolStaticCidr extends Resource<
  "Azure.Network.IpamPoolStaticCidr",
  IpamPoolStaticCidrProps,
  {
    /** Name of the static CIDR. */
    staticCidrName: string;
    /** ARM resource ID of the static CIDR. */
    staticCidrId: string;
    /** Name of the network manager. */
    networkManager: string;
    /** Name of the parent IPAM pool. */
    ipamPool: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Reserved prefixes. */
    addressPrefixes: string[];
    /** Description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A static CIDR reservation in an Azure Virtual Network Manager IPAM pool —
 * address space used outside Azure (on-premises, other clouds) that IPAM
 * must not allocate to virtual networks. It carries no tags: ownership
 * follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/how-to-manage-ip-addresses-network-manager
 *
 * ### Reserving Space
 * **Example:** Reserve an on-premises range
 * ```typescript
 * yield* Azure.Network.IpamPoolStaticCidr("on-prem", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   ipamPool: root.ipamPoolName,
 *   addressPrefixes: ["10.0.5.0/24"],
 * });
 * ```
 *
 * @resource
 */
export const IpamPoolStaticCidr = Resource<IpamPoolStaticCidr>(
  "Azure.Network.IpamPoolStaticCidr",
);

export const IpamPoolStaticCidrProvider = () =>
  Provider.succeed(
    IpamPoolStaticCidr,
    networkProvider<IpamPoolStaticCidr>()({
      label: "IPAM static CIDR",
      nameAttr: "staticCidrName",
      parents: ["networkManager", "ipamPool"],
      tracked: false,
      deleteFirst: true,
      physicalName: networkManagerChildName,
      immutable: (news, output) =>
        news.addressPrefixes !== undefined &&
        !sameSet(news.addressPrefixes, output.addressPrefixes),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetStaticCidr({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            poolName: path.ipamPool!,
            staticCidrName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.CreateStaticCidr({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          poolName: path.ipamPool!,
          staticCidrName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteStaticCidr({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          poolName: path.ipamPool!,
          staticCidrName: path.name,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          addressPrefixes: news.addressPrefixes,
          numberOfIPAddressesToAllocate: news.addressPrefixes
            ? undefined
            : news.numberOfIPAddressesToAllocate,
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties?.description ?? undefined) !== news.description,
      toAttrs: (path, observed) => ({
        staticCidrName: path.name,
        staticCidrId: observed.id ?? "",
        networkManager: path.networkManager!,
        ipamPool: path.ipamPool!,
        resourceGroup: path.resourceGroup,
        addressPrefixes: [...(observed.properties?.addressPrefixes ?? [])],
        description: observed.properties?.description,
      }),
      dependsOn: ["Azure.Network.IpamPool", "Azure.Network.NetworkManager"],
    }),
  );
