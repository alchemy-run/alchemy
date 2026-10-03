import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ref, sameId, sameSet } from "./common.ts";
import { networkProvider, subsetDiffers } from "./generic.ts";

export type BastionSku = "Developer" | "Basic" | "Standard" | "Premium";

const SKU_RANK: Record<string, number> = {
  developer: 0,
  basic: 1,
  standard: 2,
  premium: 3,
};

export interface BastionHostProps {
  /** Resource group of the bastion. Changing it replaces the bastion. */
  resourceGroup: string;
  /**
   * Name of the bastion: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the bastion.
   */
  name?: string;
  /**
   * Azure location (the VNet's). Changing it replaces the bastion.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Bastion SKU. `Developer` is free, shared, and needs only
   * `virtualNetworkId`; the others need `subnetId` + `publicIpAddressId`.
   * Upgrades apply in place; a downgrade replaces the bastion.
   * @default "Basic"
   */
  sku?: BastionSku;
  /**
   * ARM ID of the virtual network (Developer SKU). Changing it replaces
   * the bastion.
   */
  virtualNetworkId?: string;
  /**
   * ARM ID of the `AzureBastionSubnet` (at least `/26`; Basic and above).
   * Changing it replaces the bastion.
   */
  subnetId?: string;
  /**
   * ARM ID of a Standard public IP (Basic and above, unless
   * `enablePrivateOnlyBastion`).
   */
  publicIpAddressId?: string;
  /** Availability zones. Changing them replaces the bastion. */
  zones?: string[];
  /**
   * Scale units (Standard and Premium, 2-50).
   * @default 2
   */
  scaleUnits?: number;
  /** Disable copy/paste in sessions. */
  disableCopyPaste?: boolean;
  /** Enable file transfer (Standard and above). */
  enableFileCopy?: boolean;
  /** Connect to VMs by IP address (Standard and above). */
  enableIpConnect?: boolean;
  /** Enable shareable links (Standard and above). */
  enableShareableLink?: boolean;
  /** Enable native-client tunneling (Standard and above). */
  enableTunneling?: boolean;
  /** Enable Kerberos authentication. */
  enableKerberos?: boolean;
  /** Enable session recording (Premium). */
  enableSessionRecording?: boolean;
  /** Private-only deployment without a public IP (Premium). */
  enablePrivateOnlyBastion?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface BastionHost extends Resource<
  "Azure.Network.BastionHost",
  BastionHostProps,
  {
    /** Name of the bastion. */
    bastionHostName: string;
    /** ARM resource ID of the bastion. */
    bastionHostId: string;
    /** Resource group of the bastion. */
    resourceGroup: string;
    /** Location of the bastion. */
    location: string;
    /** Bastion SKU. */
    sku: string | undefined;
    /** DNS name of the bastion endpoint. */
    dnsName: string | undefined;
    /** ARM ID of the virtual network (Developer SKU). */
    virtualNetworkId: string | undefined;
    /** ARM ID of the bastion subnet. */
    subnetId: string | undefined;
    /** Availability zones. */
    zones: string[];
    /** Scale units. */
    scaleUnits: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Bastion host — browser and native-client RDP/SSH to VMs in a
 * virtual network without public IPs on the VMs. The `Developer` SKU is
 * free (shared infrastructure, limited regions); Basic bills about
 * $0.19/hour and takes 5-10 minutes to provision.
 *
 * @see https://learn.microsoft.com/azure/bastion/bastion-overview
 *
 * ### Creating a Bastion
 * **Example:** Free Developer bastion
 * ```typescript
 * const bastion = yield* Azure.Network.BastionHost("dev", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Developer",
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * ```
 *
 * **Example:** Standard bastion with tunneling
 * ```typescript
 * const bastion = yield* Azure.Network.BastionHost("ops", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   subnetId: bastionSubnet.subnetId,
 *   publicIpAddressId: ip.publicIpAddressId,
 *   enableTunneling: true,
 * });
 * ```
 *
 * @resource
 */
export const BastionHost = Resource<BastionHost>("Azure.Network.BastionHost");

export const BastionHostProvider = () =>
  Provider.succeed(
    BastionHost,
    networkProvider<BastionHost>()({
      label: "bastion host",
      nameAttr: "bastionHostName",
      tracked: true,
      slow: true,
      // A bastion owns its subnet and public IP exclusively.
      deleteFirst: true,
      immutable: (news, output) =>
        (SKU_RANK[(news.sku ?? "Basic").toLowerCase()] ?? 0) <
          (SKU_RANK[(output.sku ?? "").toLowerCase()] ?? 0) ||
        (news.virtualNetworkId !== undefined &&
          output.virtualNetworkId !== undefined &&
          !sameId(news.virtualNetworkId, output.virtualNetworkId)) ||
        (news.subnetId !== undefined &&
          output.subnetId !== undefined &&
          !sameId(news.subnetId, output.subnetId)) ||
        !sameSet(news.zones, output.zones),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetBastionHost({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            bastionHostName: path.name,
          }),
        ),
      body: (news, { location, tags }) => ({
        location,
        tags,
        zones: news.zones,
        sku: { name: news.sku ?? "Basic" },
        properties: {
          virtualNetwork: ref(news.virtualNetworkId),
          ipConfigurations:
            news.subnetId === undefined
              ? undefined
              : [
                  {
                    name: "IpConf",
                    properties: {
                      subnet: { id: news.subnetId },
                      publicIPAddress: ref(news.publicIpAddressId),
                    },
                  },
                ],
          scaleUnits: news.scaleUnits,
          disableCopyPaste: news.disableCopyPaste,
          enableFileCopy: news.enableFileCopy,
          enableIpConnect: news.enableIpConnect,
          enableShareableLink: news.enableShareableLink,
          enableTunneling: news.enableTunneling,
          enableKerberos: news.enableKerberos,
          enableSessionRecording: news.enableSessionRecording,
          enablePrivateOnlyBastion: news.enablePrivateOnlyBastion,
        },
      }),
      put: (subscriptionId, path, body) =>
        network.BastionHostsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          bastionHostName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteBastionHost({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          bastionHostName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateBastionHostTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          bastionHostName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListBastionHosts({ subscriptionId }),
      drifted: (observed, body) =>
        subsetDiffers({ sku: body.sku, properties: body.properties }, observed),
      toAttrs: (path, observed) => ({
        bastionHostName: path.name,
        bastionHostId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        sku: observed.sku?.name,
        dnsName: observed.properties?.dnsName,
        virtualNetworkId: observed.properties?.virtualNetwork?.id,
        subnetId:
          observed.properties?.ipConfigurations?.[0]?.properties?.subnet?.id,
        zones: [...(observed.zones ?? [])],
        scaleUnits: observed.properties?.scaleUnits,
        tags: userTags(observed.tags),
      }),
      dependsOn: [
        "Azure.Network.VirtualNetwork",
        "Azure.Network.Subnet",
        "Azure.Network.PublicIpAddress",
      ],
    }),
  );
