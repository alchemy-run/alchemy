import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { idsOf, networkProvider, subsetDiffers } from "./generic.ts";

/** Point-to-site settings of a VPN gateway. */
export interface VpnClientSettings {
  /** Client address pool, e.g. `["172.16.201.0/24"]`. */
  addressPrefixes: string[];
  /** Tunnel protocols, e.g. `["OpenVPN"]`. */
  protocols?: ("IkeV2" | "SSTP" | "OpenVPN")[];
  /** Authentication types, e.g. `["Certificate"]`. */
  authenticationTypes?: ("Certificate" | "Radius" | "AAD")[];
  /** Trusted root certificates (certificate authentication). */
  rootCertificates?: { name: string; publicCertData: string }[];
  /** Entra tenant URL (AAD authentication). */
  aadTenant?: string;
  /** Entra audience (AAD authentication). */
  aadAudience?: string;
  /** Entra issuer URL (AAD authentication). */
  aadIssuer?: string;
}

export interface VirtualNetworkGatewayProps {
  /** Resource group of the gateway. Changing it replaces the gateway. */
  resourceGroup: string;
  /**
   * Name of the gateway: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location (the VNet's). Changing it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Gateway type. Changing it replaces the gateway.
   * @default "Vpn"
   */
  gatewayType?: "Vpn" | "ExpressRoute";
  /**
   * VPN routing type. Changing it replaces the gateway.
   * @default "RouteBased"
   */
  vpnType?: "RouteBased" | "PolicyBased";
  /**
   * Gateway SKU, e.g. `VpnGw1AZ` or `ErGw1AZ`. Resizes within a SKU family
   * apply in place.
   * @default "VpnGw1AZ"
   */
  sku?: string;
  /**
   * VPN gateway generation.
   * @default "Generation1"
   */
  generation?: "Generation1" | "Generation2";
  /**
   * ARM ID of the VNet's `GatewaySubnet` (at least `/27`). Changing it
   * replaces the gateway.
   */
  subnetId: string;
  /**
   * ARM IDs of Standard public IPs: one, or two for active-active.
   */
  publicIpAddressIds: string[];
  /**
   * Active-active mode (needs two public IPs).
   * @default false
   */
  activeActive?: boolean;
  /**
   * Enable BGP.
   * @default false
   */
  enableBgp?: boolean;
  /** BGP ASN of the gateway (when `enableBgp`). */
  bgpAsn?: number;
  /** Point-to-site configuration. */
  vpnClient?: VpnClientSettings;
  /** Extra address prefixes advertised to P2S clients. */
  customRoutes?: string[];
  /** Allow private IP connectivity over ExpressRoute. */
  enablePrivateIpAddress?: boolean;
  /** Translate BGP routes through NAT rules. */
  enableBgpRouteTranslationForNat?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VirtualNetworkGateway extends Resource<
  "Azure.Network.VirtualNetworkGateway",
  VirtualNetworkGatewayProps,
  {
    /** Name of the gateway. */
    virtualNetworkGatewayName: string;
    /** ARM resource ID of the gateway. */
    virtualNetworkGatewayId: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** Location of the gateway. */
    location: string;
    /** Gateway type. */
    gatewayType: string | undefined;
    /** VPN routing type. */
    vpnType: string | undefined;
    /** Gateway SKU. */
    sku: string | undefined;
    /** ARM ID of the gateway subnet. */
    subnetId: string | undefined;
    /** BGP ASN of the gateway. */
    bgpAsn: number | undefined;
    /** BGP peering address of the gateway. */
    bgpPeeringAddress: string | undefined;
    /** IDs of the gateway's NAT rules. */
    natRuleIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual network gateway — a VPN gateway (site-to-site,
 * VNet-to-VNet, point-to-site) or an ExpressRoute gateway in a VNet's
 * `GatewaySubnet`. Takes 30-45 minutes to provision; `VpnGw1AZ` bills
 * about $0.19/hour.
 *
 * @see https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-about-vpngateways
 *
 * ### Creating a VPN Gateway
 * **Example:** Route-based VPN gateway
 * ```typescript
 * const gateway = yield* Azure.Network.VirtualNetworkGateway("vpn", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "VpnGw1AZ",
 *   subnetId: gatewaySubnet.subnetId,
 *   publicIpAddressIds: [ip.publicIpAddressId],
 * });
 * ```
 *
 * **Example:** Point-to-site with Entra ID
 * ```typescript
 * const gateway = yield* Azure.Network.VirtualNetworkGateway("p2s", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: gatewaySubnet.subnetId,
 *   publicIpAddressIds: [ip.publicIpAddressId],
 *   generation: "Generation2",
 *   sku: "VpnGw2AZ",
 *   vpnClient: {
 *     addressPrefixes: ["172.16.201.0/24"],
 *     protocols: ["OpenVPN"],
 *     authenticationTypes: ["AAD"],
 *     aadTenant: `https://login.microsoftonline.com/${tenantId}`,
 *     aadAudience: "c632b3df-fb67-4d84-bdcf-b95ad541b5c8",
 *     aadIssuer: `https://sts.windows.net/${tenantId}/`,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkGateway = Resource<VirtualNetworkGateway>(
  "Azure.Network.VirtualNetworkGateway",
);

const lower = (value: string | undefined) => value?.toLowerCase();

export const VirtualNetworkGatewayProvider = () =>
  Provider.succeed(
    VirtualNetworkGateway,
    networkProvider<VirtualNetworkGateway>()({
      label: "virtual network gateway",
      nameAttr: "virtualNetworkGatewayName",
      tracked: true,
      slow: true,
      // A gateway owns its GatewaySubnet slot and public IPs.
      deleteFirst: true,
      immutable: (news, output) =>
        (output.gatewayType !== undefined &&
          lower(news.gatewayType ?? "Vpn") !== lower(output.gatewayType)) ||
        (output.vpnType !== undefined &&
          (news.gatewayType ?? "Vpn") === "Vpn" &&
          lower(news.vpnType ?? "RouteBased") !== lower(output.vpnType)) ||
        (output.subnetId !== undefined &&
          lower(news.subnetId) !== lower(output.subnetId)),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualNetworkGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualNetworkGatewayName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualNetworkGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualNetworkGateway({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVirtualNetworkGatewayTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayName: path.name,
          tags,
        }),
      // The PUT replaces the NAT-rule collection: carry the observed rules
      // (managed by VirtualNetworkGatewayNatRule).
      body: (news, { location, tags, observed }) => {
        const gatewayType = news.gatewayType ?? "Vpn";
        const sku = news.sku ?? (gatewayType === "Vpn" ? "VpnGw1AZ" : "ErGw1AZ");
        const client = news.vpnClient;
        return {
          location,
          tags,
          properties: {
            gatewayType,
            vpnType: gatewayType === "Vpn" ? (news.vpnType ?? "RouteBased") : undefined,
            vpnGatewayGeneration:
              gatewayType === "Vpn" ? (news.generation ?? "Generation1") : undefined,
            sku: { name: sku, tier: sku },
            activeActive: news.activeActive ?? false,
            enableBgp: news.enableBgp ?? false,
            bgpSettings:
              news.bgpAsn === undefined ? undefined : { asn: news.bgpAsn },
            ipConfigurations: news.publicIpAddressIds.map((ipId, i) => ({
              name: i === 0 ? "default" : `activeActive${i}`,
              properties: {
                privateIPAllocationMethod: "Dynamic",
                subnet: { id: news.subnetId },
                publicIPAddress: { id: ipId },
              },
            })),
            vpnClientConfiguration: client && {
              vpnClientAddressPool: { addressPrefixes: client.addressPrefixes },
              vpnClientProtocols: client.protocols,
              vpnAuthenticationTypes: client.authenticationTypes,
              vpnClientRootCertificates: client.rootCertificates?.map(
                (cert) => ({
                  name: cert.name,
                  properties: { publicCertData: cert.publicCertData },
                }),
              ),
              aadTenant: client.aadTenant,
              aadAudience: client.aadAudience,
              aadIssuer: client.aadIssuer,
            },
            customRoutes:
              news.customRoutes === undefined
                ? undefined
                : { addressPrefixes: news.customRoutes },
            enablePrivateIpAddress: news.enablePrivateIpAddress,
            enableBgpRouteTranslationForNat:
              news.enableBgpRouteTranslationForNat,
            natRules: observed?.properties?.natRules?.map((rule) => ({
              id: rule.id,
              name: rule.name,
              properties: rule.properties && {
                type: rule.properties.type,
                mode: rule.properties.mode,
                internalMappings: rule.properties.internalMappings,
                externalMappings: rule.properties.externalMappings,
                ipConfigurationId: rule.properties.ipConfigurationId,
              },
            })),
          },
        };
      },
      drifted: (observed, body) => {
        const { natRules: _rules, ...desired } = body.properties;
        return subsetDiffers(desired, observed.properties);
      },
      toAttrs: (path, observed) => ({
        virtualNetworkGatewayName: path.name,
        virtualNetworkGatewayId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        gatewayType: observed.properties?.gatewayType,
        vpnType: observed.properties?.vpnType,
        sku: observed.properties?.sku?.name,
        subnetId: observed.properties?.ipConfigurations?.[0]?.properties?.subnet
          ?.id,
        bgpAsn: observed.properties?.bgpSettings?.asn,
        bgpPeeringAddress: observed.properties?.bgpSettings?.bgpPeeringAddress,
        natRuleIds: idsOf(observed.properties?.natRules),
        tags: userTags(observed.tags),
      }),
      dependsOn: [
        "Azure.Network.Subnet",
        "Azure.Network.PublicIpAddress",
        "Azure.Network.VirtualNetwork",
      ],
    }),
  );
