import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { networkProvider, subsetDiffers } from "./generic.ts";

export interface IpAllocationProps {
  /** Resource group of the allocation. Changing it replaces the allocation. */
  resourceGroup: string;
  /**
   * Name of the allocation: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the allocation.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the allocation.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Allocation type. Azure only accepts `Hypernet`, which needs a
   * subscription allow-listed for Hypernet.
   * @default "Hypernet"
   */
  type?: "Undefined" | "Hypernet";
  /** Address prefix reserved by the allocation, e.g. `"10.20.0.0/24"`. */
  prefix?: string;
  /** Prefix length, when `prefix` is not given. */
  prefixLength?: number;
  /**
   * IP version of the prefix.
   * @default "IPv4"
   */
  prefixType?: "IPv4" | "IPv6";
  /** ID of the allocation in an external IP address manager. */
  ipamAllocationId?: string;
  /** Key-value metadata stored on the allocation (not ARM tags). */
  allocationTags?: Record<string, string>;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface IpAllocation extends Resource<
  "Azure.Network.IpAllocation",
  IpAllocationProps,
  {
    /** Name of the allocation. */
    ipAllocationName: string;
    /** ARM resource ID of the allocation. */
    ipAllocationId: string;
    /** Resource group of the allocation. */
    resourceGroup: string;
    /** Location of the allocation. */
    location: string;
    /** Reserved address prefix. */
    prefix: string | undefined;
    /** IP version of the prefix. */
    prefixType: string | undefined;
    /** ID of the virtual network using the allocation. */
    virtualNetworkId: string | undefined;
    /** ID of the subnet using the allocation. */
    subnetId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure IP allocation (`Microsoft.Network/IpAllocations`) — a named
 * reservation of an address prefix that virtual networks reference so
 * the range is tracked and not handed out twice. Allocations are free.
 *
 * :::caution
 * Creating an allocation needs a subscription onboarded to Hypernet
 * (allow-listed by Microsoft). Other subscriptions fail with the typed
 * `HypernetNotOnboarded` error.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/virtualnetwork/ip-allocations
 *
 * ### Reserving a Prefix
 * **Example:** Reserve a /24
 * ```typescript
 * const allocation = yield* Azure.Network.IpAllocation("reserved", {
 *   prefix: "10.20.0.0/24",
 *   allocationTags: { owner: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const IpAllocation = GroupedResource<IpAllocation>("Azure.Network.IpAllocation");

export const IpAllocationProvider = () =>
  Provider.succeed(
    IpAllocation,
    networkProvider<IpAllocation>()({
      label: "IP allocation",
      nameAttr: "ipAllocationName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetIpAllocation({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            ipAllocationName: path.name,
          }),
        ),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          type: news.type ?? "Hypernet",
          prefix: news.prefix,
          prefixLength: news.prefixLength,
          prefixType: news.prefixType ?? "IPv4",
          ipamAllocationId: news.ipamAllocationId,
          allocationTags: news.allocationTags,
        },
      }),
      put: (subscriptionId, path, body) =>
        network.IpAllocationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ipAllocationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteIpAllocation({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ipAllocationName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateIpAllocationTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ipAllocationName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListIpAllocations({ subscriptionId }),
      drifted: (observed, body) =>
        subsetDiffers(body.properties, observed.properties) ||
        Object.keys(observed.properties?.allocationTags ?? {}).length !==
          Object.keys(body.properties.allocationTags ?? {}).length,
      toAttrs: (path, observed) => ({
        ipAllocationName: path.name,
        ipAllocationId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        prefix: observed.properties?.prefix,
        prefixType: observed.properties?.prefixType,
        virtualNetworkId: observed.properties?.virtualNetwork?.id,
        subnetId: observed.properties?.subnet?.id,
        tags: userTags(observed.tags),
      }),
    }),
  );
