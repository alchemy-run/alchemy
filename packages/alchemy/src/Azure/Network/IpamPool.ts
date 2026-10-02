import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId, sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { networkManagerChildName } from "./networkManagerShared.ts";

export interface IpamPoolProps {
  /** Resource group of the network manager. Changing it replaces the pool. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the pool. */
  networkManager: string;
  /**
   * Name of the pool. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the pool.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the pool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the pool. */
  description?: string;
  /** Display name of the pool. */
  displayName?: string;
  /**
   * Name of the parent pool whose space this pool carves from. Changing it
   * replaces the pool.
   */
  parentPoolName?: string;
  /** Address prefixes (CIDRs) of the pool, e.g. `["10.0.0.0/8"]`. */
  addressPrefixes: string[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface IpamPool extends Resource<
  "Azure.Network.IpamPool",
  IpamPoolProps,
  {
    /** Name of the pool. */
    ipamPoolName: string;
    /** ARM resource ID of the pool. */
    ipamPoolId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Address prefixes of the pool. */
    addressPrefixes: string[];
    /** Parent pool name. */
    parentPoolName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** IP address types in the pool (`IPv4`/`IPv6`). */
    ipAddressType: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An IP address management (IPAM) pool in an Azure Virtual Network
 * Manager — a hierarchy of address spaces that virtual networks allocate
 * non-overlapping prefixes from. Reserve space outside Azure with
 * {@link IpamPoolStaticCidr}. IPAM pools are free.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-ip-address-management
 *
 * ### Creating Pools
 * **Example:** A root pool and a child pool
 * ```typescript
 * const root = yield* Azure.Network.IpamPool("root", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   addressPrefixes: ["10.0.0.0/8"],
 * });
 * yield* Azure.Network.IpamPool("prod", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   parentPoolName: root.ipamPoolName,
 *   addressPrefixes: ["10.1.0.0/16"],
 * });
 * ```
 *
 * @resource
 */
export const IpamPool = Resource<IpamPool>("Azure.Network.IpamPool");

export const IpamPoolProvider = () =>
  Provider.succeed(
    IpamPool,
    networkProvider<IpamPool>()({
      label: "IPAM pool",
      nameAttr: "ipamPoolName",
      parents: ["networkManager"],
      tracked: true,
      physicalName: networkManagerChildName,
      immutable: (news, output) =>
        !sameId(news.parentPoolName, output.parentPoolName),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetIpamPool({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            poolName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.CreateIpamPool({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          poolName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteIpamPool({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          poolName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateIpamPool({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          poolName: path.name,
          tags,
        }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          description: news.description,
          displayName: news.displayName,
          parentPoolName: news.parentPoolName,
          addressPrefixes: news.addressPrefixes,
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties.description ?? undefined) !== news.description ||
        (observed.properties.displayName ?? undefined) !== news.displayName ||
        !sameSet(observed.properties.addressPrefixes, news.addressPrefixes),
      toAttrs: (path, observed) => ({
        ipamPoolName: path.name,
        ipamPoolId: observed.id ?? "",
        networkManager: path.networkManager!,
        resourceGroup: path.resourceGroup,
        location: observed.location,
        addressPrefixes: [...observed.properties.addressPrefixes],
        parentPoolName: observed.properties.parentPoolName || undefined,
        description: observed.properties.description,
        displayName: observed.properties.displayName,
        ipAddressType: [...(observed.properties.ipAddressType ?? [])],
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.NetworkManager"],
    }),
  );
