import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { reveal, sameId, secretChanged } from "./common.ts";
import { networkProvider, subsetDiffers } from "./generic.ts";
import {
  routingConfigurationInput,
  type HubRoutingConfiguration,
} from "./virtualHubShared.ts";

/** The connection to one link of the remote VPN site. */
export interface VpnLinkConnectionSpec {
  /** Name of the link connection. */
  name: string;
  /** ARM ID of the VPN site link (see `VpnSite.linkIds`). */
  vpnSiteLinkId: string;
  /**
   * IPsec pre-shared key. Azure never returns it, so a change is detected
   * against the previous deploy's value. If omitted, Azure generates one.
   */
  sharedKey?: string | Redacted.Redacted<string>;
  /**
   * IKE protocol version.
   * @default "IKEv2"
   */
  protocol?: "IKEv1" | "IKEv2";
  /** Bandwidth of the link connection in Mbps. */
  bandwidthMbps?: number;
  /**
   * Enable BGP over the link (the site link must have BGP settings).
   * @default false
   */
  enableBgp?: boolean;
  /** Routing weight of the link. */
  routingWeight?: number;
  /** ARM IDs of ingress NAT rules of the gateway applied to the link. */
  ingressNatRuleIds?: string[];
  /** ARM IDs of egress NAT rules of the gateway applied to the link. */
  egressNatRuleIds?: string[];
}

export interface VpnConnectionProps {
  /** Resource group of the VPN gateway. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the parent VPN gateway. Changing it replaces the connection. */
  vpnGateway: string;
  /**
   * Name of the connection. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /** ARM ID of the remote VPN site. Changing it replaces the connection. */
  remoteVpnSiteId: string;
  /** Connections to the site's links. */
  links: VpnLinkConnectionSpec[];
  /**
   * Route the branch's internet traffic through the hub's secured edge.
   * @default false
   */
  enableInternetSecurity?: boolean;
  /** Route-table association, propagation, and route maps. */
  routing?: HubRoutingConfiguration;
}

export interface VpnConnection extends Resource<
  "Azure.Network.VpnConnection",
  VpnConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the parent VPN gateway. */
    vpnGateway: string;
    /** Resource group of the VPN gateway. */
    resourceGroup: string;
    /** ARM ID of the remote VPN site. */
    remoteVpnSiteId: string | undefined;
    /** Connection status (`Connected` once a tunnel is up). */
    connectionStatus: string | undefined;
    /** ARM IDs of the link connections. */
    linkConnectionIds: string[];
  },
  never,
  Providers
> {}

/**
 * A site-to-site connection from an Azure Virtual WAN {@link VpnGateway} to
 * a {@link VpnSite}, with one IPsec tunnel per site link. Connections
 * carry no tags: ownership follows the parent gateway.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-site-to-site-portal
 *
 * ### Connecting a Branch
 * **Example:** One-link branch with a pre-shared key
 * ```typescript
 * yield* Azure.Network.VpnConnection("branch", {
 *   resourceGroup: group.resourceGroupName,
 *   vpnGateway: gateway.vpnGatewayName,
 *   remoteVpnSiteId: site.vpnSiteId,
 *   links: [
 *     {
 *       name: "isp1",
 *       vpnSiteLinkId: site.linkIds[0],
 *       sharedKey: Redacted.make("correct-horse-battery-staple"),
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const VpnConnection = Resource<VpnConnection>(
  "Azure.Network.VpnConnection",
);

const refs = (ids: string[] | undefined) => ids?.map((id) => ({ id }));

export const VpnConnectionProvider = () =>
  Provider.succeed(
    VpnConnection,
    networkProvider<VpnConnection>()({
      label: "VPN connection",
      nameAttr: "connectionName",
      parents: ["vpnGateway"],
      tracked: false,
      slow: true,
      immutable: (news, output) =>
        output.remoteVpnSiteId !== undefined &&
        !sameId(news.remoteVpnSiteId, output.remoteVpnSiteId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVpnConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            gatewayName: path.vpnGateway!,
            connectionName: path.name,
          }),
        ),
      body: (news) => ({
        properties: {
          remoteVpnSite: { id: news.remoteVpnSiteId },
          enableInternetSecurity: news.enableInternetSecurity ?? false,
          routingConfiguration: routingConfigurationInput(news.routing),
          vpnLinkConnections: news.links.map((link) => ({
            name: link.name,
            properties: {
              vpnSiteLink: { id: link.vpnSiteLinkId },
              sharedKey: reveal(link.sharedKey),
              vpnConnectionProtocolType: link.protocol ?? "IKEv2",
              connectionBandwidth: link.bandwidthMbps,
              enableBgp: link.enableBgp ?? false,
              routingWeight: link.routingWeight,
              ingressNatRules: refs(link.ingressNatRuleIds),
              egressNatRules: refs(link.egressNatRuleIds),
            },
          })),
        },
      }),
      put: (subscriptionId, path, body) =>
        network.VpnConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.vpnGateway!,
          connectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVpnConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.vpnGateway!,
          connectionName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVpnGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            gatewayName: path.vpnGateway!,
          }),
        ).pipe(Effect.map((gateway) => gateway?.tags)),
      // Shared keys are write-only: compare everything else.
      drifted: (observed, body) =>
        subsetDiffers(
          {
            ...body.properties,
            vpnLinkConnections: body.properties.vpnLinkConnections.map(
              (link) => ({
                ...link,
                properties: { ...link.properties, sharedKey: undefined },
              }),
            ),
          },
          observed.properties,
        ),
      writeOnlyChanged: (news, olds) =>
        news.links.some((link) =>
          secretChanged(
            link.sharedKey,
            olds?.links.find((old) => old.name === link.name)?.sharedKey,
            olds !== undefined,
          ),
        ),
      toAttrs: (path, observed) => ({
        connectionName: path.name,
        connectionId: observed.id ?? "",
        vpnGateway: path.vpnGateway!,
        resourceGroup: path.resourceGroup,
        remoteVpnSiteId: observed.properties?.remoteVpnSite?.id,
        connectionStatus: observed.properties?.connectionStatus,
        linkConnectionIds: (
          observed.properties?.vpnLinkConnections ?? []
        ).flatMap((link) => (link.id === undefined ? [] : [link.id])),
      }),
      dependsOn: ["Azure.Network.VpnGateway", "Azure.Network.VpnSite"],
    }),
  );
