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

export interface ExpressRouteConnectionProps {
  /** Resource group of the gateway. Changing it replaces the connection. */
  resourceGroup: string;
  /**
   * Name of the parent ExpressRoute gateway. Changing it replaces the
   * connection.
   */
  expressRouteGateway: string;
  /**
   * Name of the connection. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * ARM ID of the circuit's private peering. Changing it replaces the
   * connection.
   */
  expressRouteCircuitPeeringId: string;
  /**
   * Authorization key of a circuit in another subscription. Azure never
   * returns it, so a change is detected against the previous deploy.
   */
  authorizationKey?: string | Redacted.Redacted<string>;
  /** Routing weight. */
  routingWeight?: number;
  /**
   * Route the circuit's internet traffic through the hub's secured edge.
   * @default false
   */
  enableInternetSecurity?: boolean;
  /** Bypass the gateway for data traffic (FastPath; Ultra/ErGw3AZ). */
  expressRouteGatewayBypass?: boolean;
  /** Route-table association and propagation. */
  routing?: HubRoutingConfiguration;
}

export interface ExpressRouteConnection extends Resource<
  "Azure.Network.ExpressRouteConnection",
  ExpressRouteConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the parent ExpressRoute gateway. */
    expressRouteGateway: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** ARM ID of the circuit peering. */
    expressRouteCircuitPeeringId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A connection from a Virtual WAN {@link ExpressRouteGateway} to an
 * ExpressRoute circuit's private peering. The circuit must be provisioned
 * by its connectivity provider. Connections carry no tags: ownership
 * follows the parent gateway.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-expressroute-portal
 *
 * ### Connecting a Circuit
 * **Example:** Private peering of a circuit
 * ```typescript
 * yield* Azure.Network.ExpressRouteConnection("dc", {
 *   resourceGroup: group.resourceGroupName,
 *   expressRouteGateway: gateway.expressRouteGatewayName,
 *   expressRouteCircuitPeeringId: peering.peeringId,
 * });
 * ```
 *
 * @resource
 */
export const ExpressRouteConnection = Resource<ExpressRouteConnection>(
  "Azure.Network.ExpressRouteConnection",
);

export const ExpressRouteConnectionProvider = () =>
  Provider.succeed(
    ExpressRouteConnection,
    networkProvider<ExpressRouteConnection>()({
      label: "ExpressRoute connection",
      nameAttr: "connectionName",
      parents: ["expressRouteGateway"],
      tracked: false,
      slow: true,
      immutable: (news, output) =>
        output.expressRouteCircuitPeeringId !== undefined &&
        !sameId(
          news.expressRouteCircuitPeeringId,
          output.expressRouteCircuitPeeringId,
        ),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            expressRouteGatewayName: path.expressRouteGateway!,
            connectionName: path.name,
          }),
        ),
      body: (news, { path }) => ({
        name: path.name,
        properties: {
          expressRouteCircuitPeering: { id: news.expressRouteCircuitPeeringId },
          authorizationKey: reveal(news.authorizationKey),
          routingWeight: news.routingWeight,
          enableInternetSecurity: news.enableInternetSecurity ?? false,
          expressRouteGatewayBypass: news.expressRouteGatewayBypass,
          routingConfiguration: routingConfigurationInput(news.routing),
        },
      }),
      put: (subscriptionId, path, body) =>
        network.ExpressRouteConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteGatewayName: path.expressRouteGateway!,
          connectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteExpressRouteConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteGatewayName: path.expressRouteGateway!,
          connectionName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            expressRouteGatewayName: path.expressRouteGateway!,
          }),
        ).pipe(Effect.map((gateway) => gateway?.tags)),
      drifted: (observed, body) => {
        const { authorizationKey: _key, ...desired } = body.properties;
        return subsetDiffers(desired, observed.properties);
      },
      writeOnlyChanged: (news, olds) =>
        secretChanged(
          news.authorizationKey,
          olds?.authorizationKey,
          olds !== undefined,
        ),
      toAttrs: (path, observed) => ({
        connectionName: path.name,
        connectionId: observed.id ?? "",
        expressRouteGateway: path.expressRouteGateway!,
        resourceGroup: path.resourceGroup,
        expressRouteCircuitPeeringId:
          observed.properties?.expressRouteCircuitPeering?.id,
      }),
      dependsOn: [
        "Azure.Network.ExpressRouteGateway",
        "Azure.Network.ExpressRouteCircuitPeering",
      ],
    }),
  );
