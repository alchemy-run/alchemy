import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface VpnGatewayProps {
  /** Resource group of the gateway. Changing it replaces the gateway. */
  resourceGroup: string;
  /**
   * Name of the gateway: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location (must match the hub's). Changing it replaces the
   * gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM ID of the virtual hub. Changing it replaces the gateway. */
  virtualHubId: string;
  /**
   * Scale units (1 unit = 500 Mbps aggregate).
   * @default 1
   */
  scaleUnit?: number;
  /** BGP route weight of the gateway's peers. */
  bgpPeerWeight?: number;
  /**
   * Translate BGP routes through NAT rules.
   * @default false
   */
  enableBgpRouteTranslationForNat?: boolean;
  /**
   * Use internet routing (instead of the Microsoft network) for the
   * gateway's public IPs. Only honoured when the gateway is created.
   * @default false
   */
  isRoutingPreferenceInternet?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VpnGateway extends Resource<
  "Azure.Network.VpnGateway",
  VpnGatewayProps,
  {
    /** Name of the gateway. */
    vpnGatewayName: string;
    /** ARM resource ID of the gateway. */
    vpnGatewayId: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** Location of the gateway. */
    location: string;
    /** ARM ID of the virtual hub. */
    virtualHubId: string | undefined;
    /** Scale units. */
    scaleUnit: number | undefined;
    /** BGP ASN of the gateway (always 65515). */
    bgpAsn: number | undefined;
    /** Public IP addresses of the gateway instances. */
    publicIpAddresses: string[];
    /** Private IP addresses of the gateway instances. */
    privateIpAddresses: string[];
    /** IDs of the gateway's VPN connections. */
    connectionIds: string[];
    /** IDs of the gateway's NAT rules. */
    natRuleIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual WAN site-to-site VPN gateway in a virtual hub. Connect
 * branches with {@link VpnConnection}. Billed per scale unit (about
 * $0.36/hour for 1 unit) and takes 30+ minutes to provision.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-site-to-site-portal
 *
 * ### Creating a VPN Gateway
 * **Example:** One-unit gateway in a hub
 * ```typescript
 * const gateway = yield* Azure.Network.VpnGateway("s2s", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHubId: hub.virtualHubId,
 *   scaleUnit: 1,
 * });
 * ```
 *
 * @resource
 */
export const VpnGateway = Resource<VpnGateway>("Azure.Network.VpnGateway");

export const VpnGatewayProvider = () =>
  Provider.succeed(
    VpnGateway,
    networkProvider<VpnGateway>()({
      label: "VPN gateway",
      nameAttr: "vpnGatewayName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        output.virtualHubId !== undefined &&
        !sameId(news.virtualHubId, output.virtualHubId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVpnGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            gatewayName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VpnGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVpnGateway({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVpnGatewayTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListVpnGateways({ subscriptionId }),
      // The PUT replaces the connection and NAT-rule collections: carry the
      // observed ones (managed by VpnConnection / VpnGatewayNatRule).
      body: (news, { location, tags, observed }) => ({
        location,
        tags,
        properties: {
          virtualHub: { id: news.virtualHubId },
          vpnGatewayScaleUnit: news.scaleUnit ?? 1,
          bgpSettings:
            news.bgpPeerWeight === undefined
              ? undefined
              : { peerWeight: news.bgpPeerWeight },
          enableBgpRouteTranslationForNat:
            news.enableBgpRouteTranslationForNat ?? false,
          isRoutingPreferenceInternet: news.isRoutingPreferenceInternet,
          connections: observed?.properties?.connections,
          natRules: observed?.properties?.natRules,
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        return (
          p?.vpnGatewayScaleUnit !== (news.scaleUnit ?? 1) ||
          (p?.enableBgpRouteTranslationForNat ?? false) !==
            (news.enableBgpRouteTranslationForNat ?? false) ||
          (news.bgpPeerWeight !== undefined &&
            p?.bgpSettings?.peerWeight !== news.bgpPeerWeight)
        );
      },
      toAttrs: (path, observed) => ({
        vpnGatewayName: path.name,
        vpnGatewayId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        virtualHubId: observed.properties?.virtualHub?.id,
        scaleUnit: observed.properties?.vpnGatewayScaleUnit,
        bgpAsn: observed.properties?.bgpSettings?.asn,
        publicIpAddresses: (observed.properties?.ipConfigurations ?? []).flatMap(
          (c) => (c.publicIpAddress === undefined ? [] : [c.publicIpAddress]),
        ),
        privateIpAddresses: (
          observed.properties?.ipConfigurations ?? []
        ).flatMap((c) =>
          c.privateIpAddress === undefined ? [] : [c.privateIpAddress],
        ),
        connectionIds: idsOf(observed.properties?.connections),
        natRuleIds: idsOf(observed.properties?.natRules),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.VirtualHub"],
    }),
  );
