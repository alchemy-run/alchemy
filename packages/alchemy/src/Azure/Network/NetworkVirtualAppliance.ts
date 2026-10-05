import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetworkName,
  lower,
  ref,
  sameId,
  sameSet,
} from "./common.ts";
import { identityIds, identityInput } from "./expressRouteDirectShared.ts";
import { idsOf, networkProvider } from "./generic.ts";

/** Marketplace SKU of a network virtual appliance. */
export interface NetworkVirtualApplianceSku {
  /** Vendor offer, e.g. `"barracudasdwanrelease"` or `"ciscosdwan"`. */
  vendor: string;
  /** Scale unit, e.g. `"2"`. */
  bundledScaleUnit: string;
  /** Marketplace image version, e.g. `"latest"`. */
  marketPlaceVersion: string;
}

export interface NetworkVirtualApplianceProps {
  /** Resource group of the appliance. Changing it replaces the appliance. */
  resourceGroup: string;
  /**
   * Name of the appliance: 2-58 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the appliance.
   */
  name?: string;
  /**
   * Azure location (the hub's location). Changing it replaces the
   * appliance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Marketplace SKU. Changing the vendor replaces the appliance; scale
   * unit and version update in place.
   */
  nvaSku?: NetworkVirtualApplianceSku;
  /**
   * ARM ID of the Virtual WAN hub hosting the appliance. Changing it
   * replaces the appliance.
   */
  virtualHubId?: string;
  /**
   * BGP ASN of the appliance (Microsoft private, public, and IANA reserved
   * ASNs are not allowed). Changing it replaces the appliance.
   */
  virtualApplianceAsn?: number;
  /** SSH public key for appliance login. */
  sshPublicKey?: string;
  /** Cloud-init configuration in plain text. */
  cloudInitConfiguration?: string;
  /** Storage URLs of cloud-init configuration blobs. */
  cloudInitConfigurationBlobs?: string[];
  /** Storage URLs of bootstrap configuration blobs. */
  bootStrapConfigurationBlobs?: string[];
  /**
   * Service the appliance is delegated to (SaaS NVAs only), e.g.
   * `"PaloAltoNetworks.Cloudngfw/firewalls"`. Changing it replaces the
   * appliance.
   */
  delegationServiceName?: string;
  /** ARM IDs of public IPs used for internet ingress (DNAT). */
  internetIngressPublicIpIds?: string[];
  /** User-assigned identities of the appliance. */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkVirtualAppliance extends Resource<
  "Azure.Network.NetworkVirtualAppliance",
  NetworkVirtualApplianceProps,
  {
    /** Name of the appliance. */
    networkVirtualApplianceName: string;
    /** ARM resource ID of the appliance. */
    networkVirtualApplianceId: string;
    /** Resource group of the appliance. */
    resourceGroup: string;
    /** Location of the appliance. */
    location: string;
    /** Marketplace vendor. */
    vendor: string | undefined;
    /** Scale unit. */
    bundledScaleUnit: string | undefined;
    /** ARM ID of the hosting hub. */
    virtualHubId: string | undefined;
    /** BGP ASN. */
    virtualApplianceAsn: number | undefined;
    /** Private IP address of the appliance. */
    privateIpAddress: string | undefined;
    /** Deployment type (`NVAInVHub`, `PartnerManaged`, ...). */
    deploymentType: string | undefined;
    /** IDs of the appliance's hub connections. */
    connectionIds: string[];
    /** User-assigned identity IDs. */
    userAssignedIdentityIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure network virtual appliance (NVA) in a Virtual WAN hub — a
 * marketplace third-party firewall or SD-WAN appliance (Barracuda, Cisco,
 * Fortinet, ...) or a SaaS NVA (delegated to the partner) deployed into the
 * hub and peered with its router. Marketplace terms must be accepted and the
 * vendor billed separately.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/about-nva-hub
 *
 * ### Deploying an NVA in a Hub
 * **Example:** SD-WAN appliance
 * ```typescript
 * const nva = yield* Azure.Network.NetworkVirtualAppliance("sdwan", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHubId: hub.virtualHubId,
 *   nvaSku: {
 *     vendor: "barracudasdwanrelease",
 *     bundledScaleUnit: "2",
 *     marketPlaceVersion: "latest",
 *   },
 *   virtualApplianceAsn: 64512,
 * });
 * ```
 *
 * @resource
 */
export const NetworkVirtualAppliance = Resource<NetworkVirtualAppliance>(
  "Azure.Network.NetworkVirtualAppliance",
);

export const NetworkVirtualApplianceProvider = () =>
  Provider.succeed(
    NetworkVirtualAppliance,
    networkProvider<NetworkVirtualAppliance>()({
      label: "network virtual appliance",
      nameAttr: "networkVirtualApplianceName",
      tracked: true,
      // Azure caps NVA names at 58 characters.
      physicalName: (id) => createNetworkName(id, 58),
      // NVA deployments take 15-30 minutes.
      slow: true,
      immutable: (news, output) =>
        (news.nvaSku !== undefined &&
          lower(news.nvaSku.vendor) !== lower(output.vendor)) ||
        (news.virtualHubId !== undefined &&
          !sameId(news.virtualHubId, output.virtualHubId)) ||
        (news.virtualApplianceAsn !== undefined &&
          news.virtualApplianceAsn !== output.virtualApplianceAsn),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkVirtualAppliance({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkVirtualApplianceName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkVirtualAppliancesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkVirtualApplianceName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkVirtualAppliance({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkVirtualApplianceName: path.name,
        }),
      // No `updateTags`: Azure answers the tags PATCH with "Patch Method is
      // not yet supported for this Region or Subscription", so tag changes
      // re-apply the PUT.
      listAll: (subscriptionId) =>
        network.ListNetworkVirtualAppliances({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        identity: identityInput(news.userAssignedIdentityIds),
        properties: {
          nvaSku: news.nvaSku,
          virtualHub: ref(news.virtualHubId),
          virtualApplianceAsn: news.virtualApplianceAsn,
          sshPublicKey: news.sshPublicKey,
          cloudInitConfiguration: news.cloudInitConfiguration,
          cloudInitConfigurationBlobs: news.cloudInitConfigurationBlobs,
          bootStrapConfigurationBlobs: news.bootStrapConfigurationBlobs,
          delegation:
            news.delegationServiceName === undefined
              ? undefined
              : { serviceName: news.delegationServiceName },
          internetIngressPublicIps: news.internetIngressPublicIpIds?.map(
            (id) => ({ id }),
          ),
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        return (
          (news.nvaSku !== undefined &&
            (p?.nvaSku?.bundledScaleUnit !== news.nvaSku.bundledScaleUnit ||
              lower(p?.nvaSku?.marketPlaceVersion) !==
                lower(news.nvaSku.marketPlaceVersion))) ||
          (news.sshPublicKey !== undefined &&
            p?.sshPublicKey !== news.sshPublicKey) ||
          (news.cloudInitConfiguration !== undefined &&
            p?.cloudInitConfiguration !== news.cloudInitConfiguration) ||
          (news.internetIngressPublicIpIds !== undefined &&
            !sameSet(
              idsOf(p?.internetIngressPublicIps),
              news.internetIngressPublicIpIds,
            )) ||
          (news.userAssignedIdentityIds !== undefined &&
            !sameSet(
              identityIds(observed.identity),
              news.userAssignedIdentityIds,
            ))
        );
      },
      toAttrs: (path, observed) => ({
        networkVirtualApplianceName: path.name,
        networkVirtualApplianceId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        vendor: observed.properties?.nvaSku?.vendor,
        bundledScaleUnit: observed.properties?.nvaSku?.bundledScaleUnit,
        virtualHubId: observed.properties?.virtualHub?.id,
        virtualApplianceAsn: observed.properties?.virtualApplianceAsn,
        privateIpAddress: observed.properties?.privateIpAddress,
        deploymentType: observed.properties?.deploymentType,
        connectionIds: idsOf(observed.properties?.virtualApplianceConnections),
        userAssignedIdentityIds: identityIds(observed.identity),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.VirtualHub"],
    }),
  );
