import * as network from "@distilled.cloud/azure/network";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { reveal, sameId, secretChanged } from "./common.ts";
import { networkProvider, subsetDiffers } from "./generic.ts";

export interface VirtualNetworkGatewayConnectionProps {
  /** Resource group of the connection. Changing it replaces the connection. */
  resourceGroup: string;
  /**
   * Name of the connection: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * Azure location (the gateway's). Changing it replaces the connection.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Connection type: `IPsec` (to a local network gateway), `Vnet2Vnet` (to
   * another VNet gateway), or `ExpressRoute` (to a circuit). Changing it
   * replaces the connection.
   */
  connectionType: "IPsec" | "Vnet2Vnet" | "ExpressRoute";
  /** ARM ID of the local VNet gateway. Changing it replaces the connection. */
  virtualNetworkGatewayId: string;
  /**
   * ARM ID of the on-premises local network gateway (`IPsec`). Changing it
   * replaces the connection.
   */
  localNetworkGatewayId?: string;
  /**
   * ARM ID of the remote VNet gateway (`Vnet2Vnet`). Changing it replaces
   * the connection.
   */
  peerVirtualNetworkGatewayId?: string;
  /**
   * ARM ID of the ExpressRoute circuit (`ExpressRoute`). Changing it
   * replaces the connection.
   */
  expressRouteCircuitId?: string;
  /** Authorization key of a circuit in another subscription. */
  authorizationKey?: string | Redacted.Redacted<string>;
  /**
   * IPsec pre-shared key. Azure never returns it, so a change is detected
   * against the previous deploy's value.
   */
  sharedKey?: string | Redacted.Redacted<string>;
  /**
   * IKE protocol version.
   * @default "IKEv2"
   */
  connectionProtocol?: "IKEv1" | "IKEv2";
  /**
   * Enable BGP on the connection.
   * @default false
   */
  enableBgp?: boolean;
  /** Routing weight. */
  routingWeight?: number;
  /** Dead-peer-detection timeout in seconds (9-3600). */
  dpdTimeoutSeconds?: number;
  /** Use policy-based traffic selectors. */
  usePolicyBasedTrafficSelectors?: boolean;
  /** ARM IDs of gateway NAT rules applied to ingress traffic. */
  ingressNatRuleIds?: string[];
  /** ARM IDs of gateway NAT rules applied to egress traffic. */
  egressNatRuleIds?: string[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VirtualNetworkGatewayConnection extends Resource<
  "Azure.Network.VirtualNetworkGatewayConnection",
  VirtualNetworkGatewayConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Resource group of the connection. */
    resourceGroup: string;
    /** Location of the connection. */
    location: string;
    /** Connection type. */
    connectionType: string | undefined;
    /** ARM ID of the local VNet gateway. */
    virtualNetworkGatewayId: string | undefined;
    /** Connection status (`Connected` once the tunnel is up). */
    connectionStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A connection of an Azure {@link VirtualNetworkGateway}: a site-to-site
 * IPsec tunnel to a {@link LocalNetworkGateway}, a VNet-to-VNet tunnel to
 * another VNet gateway, or a link to an ExpressRoute circuit.
 *
 * @see https://learn.microsoft.com/azure/vpn-gateway/tutorial-site-to-site-portal
 *
 * ### Connecting a Site
 * **Example:** Site-to-site IPsec
 * ```typescript
 * yield* Azure.Network.VirtualNetworkGatewayConnection("onprem", {
 *   resourceGroup: group.resourceGroupName,
 *   connectionType: "IPsec",
 *   virtualNetworkGatewayId: gateway.virtualNetworkGatewayId,
 *   localNetworkGatewayId: onPrem.localNetworkGatewayId,
 *   sharedKey: Redacted.make("correct-horse-battery-staple"),
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkGatewayConnection =
  Resource<VirtualNetworkGatewayConnection>(
    "Azure.Network.VirtualNetworkGatewayConnection",
  );

const gatewayRef = (id: string | undefined) =>
  id === undefined ? undefined : { id, properties: {} };
const refs = (ids: string[] | undefined) => ids?.map((id) => ({ id }));

export const VirtualNetworkGatewayConnectionProvider = () =>
  Provider.succeed(
    VirtualNetworkGatewayConnection,
    networkProvider<VirtualNetworkGatewayConnection>()({
      label: "virtual network gateway connection",
      nameAttr: "connectionName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        (output.connectionType !== undefined &&
          news.connectionType.toLowerCase() !==
            output.connectionType.toLowerCase()) ||
        (output.virtualNetworkGatewayId !== undefined &&
          !sameId(news.virtualNetworkGatewayId, output.virtualNetworkGatewayId)),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualNetworkGatewayConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualNetworkGatewayConnectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualNetworkGatewayConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayConnectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualNetworkGatewayConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayConnectionName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVirtualNetworkGatewayConnectionTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayConnectionName: path.name,
          tags,
        }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          connectionType: news.connectionType,
          virtualNetworkGateway1: { id: news.virtualNetworkGatewayId, properties: {} },
          virtualNetworkGateway2: gatewayRef(news.peerVirtualNetworkGatewayId),
          localNetworkGateway2: gatewayRef(news.localNetworkGatewayId),
          peer:
            news.expressRouteCircuitId === undefined
              ? undefined
              : { id: news.expressRouteCircuitId },
          authorizationKey: reveal(news.authorizationKey),
          sharedKey: reveal(news.sharedKey),
          connectionProtocol:
            news.connectionType === "ExpressRoute"
              ? undefined
              : (news.connectionProtocol ?? "IKEv2"),
          enableBgp: news.enableBgp ?? false,
          routingWeight: news.routingWeight,
          dpdTimeoutSeconds: news.dpdTimeoutSeconds,
          usePolicyBasedTrafficSelectors: news.usePolicyBasedTrafficSelectors,
          ingressNatRules: refs(news.ingressNatRuleIds),
          egressNatRules: refs(news.egressNatRuleIds),
        },
      }),
      // Keys are write-only; gateway references compare by ID only.
      drifted: (observed, body) => {
        const {
          sharedKey: _shared,
          authorizationKey: _auth,
          virtualNetworkGateway1,
          virtualNetworkGateway2,
          localNetworkGateway2,
          ...desired
        } = body.properties;
        const p = observed.properties;
        return (
          subsetDiffers(desired, p) ||
          !sameId(virtualNetworkGateway1.id, p?.virtualNetworkGateway1?.id) ||
          (virtualNetworkGateway2 !== undefined &&
            !sameId(virtualNetworkGateway2.id, p?.virtualNetworkGateway2?.id)) ||
          (localNetworkGateway2 !== undefined &&
            !sameId(localNetworkGateway2.id, p?.localNetworkGateway2?.id))
        );
      },
      writeOnlyChanged: (news, olds) =>
        secretChanged(news.sharedKey, olds?.sharedKey, olds !== undefined) ||
        secretChanged(
          news.authorizationKey,
          olds?.authorizationKey,
          olds !== undefined,
        ),
      toAttrs: (path, observed) => ({
        connectionName: path.name,
        connectionId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        connectionType: observed.properties?.connectionType,
        virtualNetworkGatewayId: observed.properties?.virtualNetworkGateway1?.id,
        connectionStatus: observed.properties?.connectionStatus,
        tags: userTags(observed.tags),
      }),
      dependsOn: [
        "Azure.Network.VirtualNetworkGateway",
        "Azure.Network.LocalNetworkGateway",
      ],
    }),
  );
