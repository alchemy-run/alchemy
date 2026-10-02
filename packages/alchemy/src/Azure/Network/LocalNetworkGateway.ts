import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface LocalNetworkGatewayProps {
  /** Resource group of the gateway. Changing it replaces the gateway. */
  resourceGroup: string;
  /**
   * Name of the local network gateway: 1-80 letters, digits, `_`, `.`,
   * and `-`. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Public IP of the on-premises VPN device. Set this or `fqdn`. */
  gatewayIpAddress?: string;
  /** FQDN of the on-premises VPN device. Set this or `gatewayIpAddress`. */
  fqdn?: string;
  /** On-premises address prefixes routed over the tunnel. */
  addressPrefixes?: string[];
  /** BGP settings of the on-premises device. */
  bgpSettings?: {
    /** On-premises BGP ASN. */
    asn?: number;
    /** On-premises BGP peer IP. */
    bgpPeeringAddress?: string;
    /** Weight added to routes learned from this peer. */
    peerWeight?: number;
  };
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface LocalNetworkGateway extends Resource<
  "Azure.Network.LocalNetworkGateway",
  LocalNetworkGatewayProps,
  {
    /** Name of the local network gateway. */
    localNetworkGatewayName: string;
    /** ARM resource ID of the local network gateway. */
    localNetworkGatewayId: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** Location of the gateway. */
    location: string;
    /** On-premises device IP. */
    gatewayIpAddress: string | undefined;
    /** On-premises device FQDN. */
    fqdn: string | undefined;
    /** On-premises address prefixes. */
    addressPrefixes: string[];
    /** On-premises BGP ASN. */
    bgpAsn: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure local network gateway — the on-premises side of a site-to-site
 * VPN: the device's public IP or FQDN and the address prefixes behind it.
 * Connect it to a VPN {@link VirtualNetworkGateway} with a
 * {@link VirtualNetworkGatewayConnection}. Local network gateways are free.
 *
 * @see https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-howto-site-to-site-resource-manager-portal
 *
 * ### Creating a Local Network Gateway
 * **Example:** On-premises site
 * ```typescript
 * const site = yield* Azure.Network.LocalNetworkGateway("office", {
 *   resourceGroup: group.resourceGroupName,
 *   gatewayIpAddress: "203.0.113.10",
 *   addressPrefixes: ["192.168.0.0/16"],
 * });
 * ```
 *
 * @resource
 */
export const LocalNetworkGateway = Resource<LocalNetworkGateway>(
  "Azure.Network.LocalNetworkGateway",
);

export const LocalNetworkGatewayProvider = () =>
  Provider.succeed(
    LocalNetworkGateway,
    networkProvider<LocalNetworkGateway>()({
      label: "local network gateway",
      nameAttr: "localNetworkGatewayName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetLocalNetworkGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            localNetworkGatewayName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.LocalNetworkGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          localNetworkGatewayName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteLocalNetworkGateway({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          localNetworkGatewayName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateLocalNetworkGatewayTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          localNetworkGatewayName: path.name,
          tags,
        }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          gatewayIpAddress: news.gatewayIpAddress,
          fqdn: news.fqdn,
          localNetworkAddressSpace: {
            addressPrefixes: news.addressPrefixes ?? [],
          },
          bgpSettings: news.bgpSettings,
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        return (
          p?.gatewayIpAddress !== news.gatewayIpAddress ||
          p?.fqdn !== news.fqdn ||
          !sameSet(
            p?.localNetworkAddressSpace?.addressPrefixes,
            news.addressPrefixes,
          ) ||
          (news.bgpSettings !== undefined &&
            (p?.bgpSettings?.asn !== news.bgpSettings.asn ||
              p?.bgpSettings?.bgpPeeringAddress !==
                news.bgpSettings.bgpPeeringAddress ||
              (news.bgpSettings.peerWeight !== undefined &&
                p?.bgpSettings?.peerWeight !== news.bgpSettings.peerWeight)))
        );
      },
      toAttrs: (path, observed) => ({
        localNetworkGatewayName: path.name,
        localNetworkGatewayId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        gatewayIpAddress: observed.properties?.gatewayIpAddress,
        fqdn: observed.properties?.fqdn,
        addressPrefixes: [
          ...(observed.properties?.localNetworkAddressSpace?.addressPrefixes ??
            []),
        ],
        bgpAsn: observed.properties?.bgpSettings?.asn,
        tags: userTags(observed.tags),
      }),
    }),
  );
