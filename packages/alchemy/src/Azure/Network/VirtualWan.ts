import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface VirtualWanProps {
  /** Resource group of the virtual WAN. Changing it replaces the WAN. */
  resourceGroup: string;
  /**
   * Name of the virtual WAN: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the WAN.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the WAN.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * WAN type. `Basic` supports only site-to-site VPN; `Standard` adds
   * ExpressRoute, point-to-site, VNet transit, and hub routing. A Basic WAN
   * can be upgraded to Standard in place; Azure rejects a downgrade.
   * @default "Standard"
   */
  type?: "Basic" | "Standard";
  /**
   * Disable VPN encryption between hubs and branches.
   * @default false
   */
  disableVpnEncryption?: boolean;
  /**
   * Allow branch-to-branch traffic through the hubs.
   * @default true
   */
  allowBranchToBranchTraffic?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VirtualWan extends Resource<
  "Azure.Network.VirtualWan",
  VirtualWanProps,
  {
    /** Name of the virtual WAN. */
    virtualWanName: string;
    /** ARM resource ID of the virtual WAN. */
    virtualWanId: string;
    /** Resource group of the virtual WAN. */
    resourceGroup: string;
    /** Location of the virtual WAN. */
    location: string;
    /** WAN type (`Basic` or `Standard`). */
    type: string | undefined;
    /** Whether VPN encryption is disabled. */
    disableVpnEncryption: boolean | undefined;
    /** Whether branch-to-branch traffic is allowed. */
    allowBranchToBranchTraffic: boolean | undefined;
    /** IDs of the virtual hubs in the WAN. */
    virtualHubIds: string[];
    /** IDs of the VPN sites in the WAN. */
    vpnSiteIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual WAN — the global container for virtual hubs, VPN sites,
 * and their gateways. The WAN object itself is free; hubs and gateways are
 * billed.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-about
 *
 * ### Creating a Virtual WAN
 * **Example:** Standard WAN
 * ```typescript
 * const wan = yield* Azure.Network.VirtualWan("wan", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Basic WAN without branch-to-branch traffic
 * ```typescript
 * const wan = yield* Azure.Network.VirtualWan("wan", {
 *   resourceGroup: group.resourceGroupName,
 *   type: "Basic",
 *   allowBranchToBranchTraffic: false,
 * });
 * ```
 *
 * @resource
 */
export const VirtualWan = Resource<VirtualWan>("Azure.Network.VirtualWan");

export const VirtualWanProvider = () =>
  Provider.succeed(
    VirtualWan,
    networkProvider<VirtualWan>()({
      label: "virtual WAN",
      nameAttr: "virtualWanName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualWan({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            VirtualWANName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualWansCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          VirtualWANName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualWan({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          VirtualWANName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVirtualWanTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          VirtualWANName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListVirtualWans({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          type: news.type ?? "Standard",
          disableVpnEncryption: news.disableVpnEncryption ?? false,
          allowBranchToBranchTraffic: news.allowBranchToBranchTraffic ?? true,
        },
      }),
      toAttrs: (path, observed) => ({
        virtualWanName: path.name,
        virtualWanId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        type: observed.properties?.type,
        disableVpnEncryption: observed.properties?.disableVpnEncryption,
        allowBranchToBranchTraffic:
          observed.properties?.allowBranchToBranchTraffic,
        virtualHubIds: idsOf(observed.properties?.virtualHubs),
        vpnSiteIds: idsOf(observed.properties?.vpnSites),
        tags: userTags(observed.tags),
      }),
    }),
  );
