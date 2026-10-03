import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower, reveal, sameId, secretChanged } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface ExpressRouteCircuitConnectionProps {
  /** Resource group of the circuit. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the parent circuit. Changing it replaces the connection. */
  circuit: string;
  /**
   * Name of the parent peering — Global Reach uses
   * `"AzurePrivatePeering"`. Changing it replaces the connection.
   */
  peering: string;
  /**
   * Name of the connection. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * ARM ID of the remote circuit's private peering
   * (`.../expressRouteCircuits/{name}/peerings/AzurePrivatePeering`).
   * Changing it replaces the connection.
   */
  peerCircuitPeeringId: string;
  /**
   * /29 IPv4 range carved into the Global Reach tunnel addresses. Changing
   * it replaces the connection.
   */
  addressPrefix: string;
  /** /125 IPv6 range for the tunnel. Changing it replaces the connection. */
  ipv6AddressPrefix?: string;
  /**
   * Authorization key of the remote circuit (when it is in another
   * subscription). Write-only.
   */
  authorizationKey?: string | Redacted.Redacted<string>;
}

export interface ExpressRouteCircuitConnection extends Resource<
  "Azure.Network.ExpressRouteCircuitConnection",
  ExpressRouteCircuitConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the parent circuit. */
    circuit: string;
    /** Name of the parent peering. */
    peering: string;
    /** Resource group of the circuit. */
    resourceGroup: string;
    /** ARM ID of the remote circuit peering. */
    peerCircuitPeeringId: string | undefined;
    /** /29 IPv4 tunnel range. */
    addressPrefix: string | undefined;
    /** /125 IPv6 tunnel range. */
    ipv6AddressPrefix: string | undefined;
    /** `Connected`, `Connecting`, or `Disconnected`. */
    circuitConnectionStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An ExpressRoute Global Reach connection — links the private peerings of
 * two ExpressRoute circuits so on-premises sites behind each circuit reach
 * each other through Microsoft's backbone. Both circuits must be
 * provisioned by their providers with private peering configured.
 * Connections carry no tags: ownership follows the parent circuit.
 *
 * @see https://learn.microsoft.com/azure/expressroute/expressroute-global-reach
 *
 * ### Connecting Two Circuits
 * **Example:** Global Reach between two sites
 * ```typescript
 * yield* Azure.Network.ExpressRouteCircuitConnection("reach", {
 *   resourceGroup: group.resourceGroupName,
 *   circuit: east.circuitName,
 *   peering: "AzurePrivatePeering",
 *   peerCircuitPeeringId: `${west.circuitId}/peerings/AzurePrivatePeering`,
 *   addressPrefix: "192.168.100.0/29",
 * });
 * ```
 *
 * @resource
 */
export const ExpressRouteCircuitConnection =
  Resource<ExpressRouteCircuitConnection>(
    "Azure.Network.ExpressRouteCircuitConnection",
  );

export const ExpressRouteCircuitConnectionProvider = () =>
  Provider.succeed(
    ExpressRouteCircuitConnection,
    networkProvider<ExpressRouteCircuitConnection>()({
      label: "ExpressRoute circuit connection",
      nameAttr: "connectionName",
      parents: ["circuit", "peering"],
      tracked: false,
      immutable: (news, output) =>
        !sameId(news.peerCircuitPeeringId, output.peerCircuitPeeringId) ||
        lower(news.addressPrefix) !== lower(output.addressPrefix) ||
        (news.ipv6AddressPrefix !== undefined &&
          lower(news.ipv6AddressPrefix) !== lower(output.ipv6AddressPrefix)),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteCircuitConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            circuitName: path.circuit!,
            peeringName: path.peering!,
            connectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ExpressRouteCircuitConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          circuitName: path.circuit!,
          peeringName: path.peering!,
          connectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteExpressRouteCircuitConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          circuitName: path.circuit!,
          peeringName: path.peering!,
          connectionName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteCircuit({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            circuitName: path.circuit!,
          }),
        ).pipe(Effect.map((circuit) => circuit?.tags)),
      body: (news, { subscriptionId, path }) => ({
        properties: {
          expressRouteCircuitPeering: {
            id: `/subscriptions/${subscriptionId}/resourceGroups/${path.resourceGroup}/providers/Microsoft.Network/expressRouteCircuits/${path.circuit}/peerings/${path.peering}`,
          },
          peerExpressRouteCircuitPeering: { id: news.peerCircuitPeeringId },
          addressPrefix: news.addressPrefix,
          authorizationKey: reveal(news.authorizationKey),
          ipv6CircuitConnectionConfig:
            news.ipv6AddressPrefix === undefined
              ? undefined
              : { addressPrefix: news.ipv6AddressPrefix },
        },
      }),
      drifted: () => false,
      writeOnlyChanged: (news, olds) =>
        secretChanged(
          news.authorizationKey,
          olds?.authorizationKey,
          olds !== undefined,
        ),
      toAttrs: (path, observed) => ({
        connectionName: path.name,
        connectionId: observed.id ?? "",
        circuit: path.circuit!,
        peering: path.peering!,
        resourceGroup: path.resourceGroup,
        peerCircuitPeeringId:
          observed.properties?.peerExpressRouteCircuitPeering?.id,
        addressPrefix: observed.properties?.addressPrefix,
        ipv6AddressPrefix:
          observed.properties?.ipv6CircuitConnectionConfig?.addressPrefix,
        circuitConnectionStatus: observed.properties?.circuitConnectionStatus,
      }),
      dependsOn: ["Azure.Network.ExpressRouteCircuit"],
    }),
  );
