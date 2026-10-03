import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower, sameId } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface VirtualNetworkApplianceProps {
  /**
   * Resource group of the appliance. Changing it replaces the appliance.
   */
  resourceGroup: string;
  /**
   * Name of the appliance: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the appliance.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the appliance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the subnet hosting the appliance; it must be named
   * `VirtualNetworkApplianceSubnet`. Changing it replaces the appliance.
   */
  subnetId: string;
  /** Bandwidth of the appliance in Gbps: `10`, `50`, `100`, or `200`. */
  bandwidthInGbps?: number;
  /**
   * IP version of the appliance's private addresses. Changing it replaces
   * the appliance.
   * @default "IPv4"
   */
  privateIpAddressVersion?: "IPv4" | "IPv6";
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualNetworkAppliance extends Resource<
  "Azure.Network.VirtualNetworkAppliance",
  VirtualNetworkApplianceProps,
  {
    /** Name of the appliance. */
    virtualNetworkApplianceName: string;
    /** ARM resource ID of the appliance. */
    virtualNetworkApplianceId: string;
    /** Resource group of the appliance. */
    resourceGroup: string;
    /** Location of the appliance. */
    location: string;
    /** ARM ID of the hosting subnet. */
    subnetId: string | undefined;
    /** Bandwidth in Gbps. */
    bandwidthInGbps: number | undefined;
    /** IP version of the private addresses. */
    privateIpAddressVersion: string | undefined;
    /** IDs of the appliance's IP configurations. */
    ipConfigurationIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual network appliance (preview) — a managed, Azure-operated
 * network appliance injected into a subnet with a configurable bandwidth.
 *
 * @see https://learn.microsoft.com/rest/api/virtualnetwork/virtual-network-appliances
 *
 * ### Creating an Appliance
 * **Example:** 10 Gbps appliance in its dedicated subnet
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("appliance", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   name: "VirtualNetworkApplianceSubnet",
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const appliance = yield* Azure.Network.VirtualNetworkAppliance("edge", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   bandwidthInGbps: 10,
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkAppliance = Resource<VirtualNetworkAppliance>(
  "Azure.Network.VirtualNetworkAppliance",
);

export const VirtualNetworkApplianceProvider = () =>
  Provider.succeed(
    VirtualNetworkAppliance,
    networkProvider<VirtualNetworkAppliance>()({
      label: "virtual network appliance",
      nameAttr: "virtualNetworkApplianceName",
      tracked: true,
      immutable: (news, output) =>
        !sameId(news.subnetId, output.subnetId) ||
        (output.privateIpAddressVersion !== undefined &&
          lower(news.privateIpAddressVersion ?? "IPv4") !==
            lower(output.privateIpAddressVersion)),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualNetworkAppliance({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualNetworkApplianceName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualNetworkAppliancesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkApplianceName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualNetworkAppliance({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkApplianceName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVirtualNetworkApplianceTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkApplianceName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListVirtualNetworkApplianceAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          subnet: { id: news.subnetId },
          bandwidthInGbps: news.bandwidthInGbps,
          privateIPAddressVersion: news.privateIpAddressVersion ?? "IPv4",
        },
      }),
      drifted: (observed, _body, news) =>
        news.bandwidthInGbps !== undefined &&
        observed.properties?.bandwidthInGbps !== news.bandwidthInGbps,
      toAttrs: (path, observed) => ({
        virtualNetworkApplianceName: path.name,
        virtualNetworkApplianceId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        subnetId: observed.properties?.subnet?.id,
        bandwidthInGbps: observed.properties?.bandwidthInGbps,
        privateIpAddressVersion: observed.properties?.privateIPAddressVersion,
        ipConfigurationIds: idsOf(observed.properties?.ipConfigurations),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.Subnet", "Azure.Network.VirtualNetwork"],
    }),
  );
