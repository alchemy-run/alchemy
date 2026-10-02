import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface ExpressRouteGatewayProps {
  /** Resource group of the gateway. Changing it replaces the gateway. */
  resourceGroup: string;
  /**
   * Name of the gateway: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location (the hub's). Changing it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM ID of the virtual hub. Changing it replaces the gateway. */
  virtualHubId: string;
  /**
   * Minimum scale units (1 unit = 2 Gbps).
   * @default 1
   */
  minScaleUnits?: number;
  /** Maximum scale units. */
  maxScaleUnits?: number;
  /**
   * Accept traffic from non-Virtual-WAN VNets.
   * @default false
   */
  allowNonVirtualWanTraffic?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface ExpressRouteGateway extends Resource<
  "Azure.Network.ExpressRouteGateway",
  ExpressRouteGatewayProps,
  {
    /** Name of the gateway. */
    expressRouteGatewayName: string;
    /** ARM resource ID of the gateway. */
    expressRouteGatewayId: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** Location of the gateway. */
    location: string;
    /** ARM ID of the virtual hub. */
    virtualHubId: string | undefined;
    /** Names of the gateway's circuit connections. */
    connectionNames: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An ExpressRoute gateway in an Azure Virtual WAN hub. Connect circuits
 * with {@link ExpressRouteConnection}. About $0.42/hour per scale unit
 * plus the hub; takes 30+ minutes to provision.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-expressroute-portal
 *
 * ### Creating an ExpressRoute Gateway
 * **Example:** One scale unit in a hub
 * ```typescript
 * const gateway = yield* Azure.Network.ExpressRouteGateway("er", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHubId: hub.virtualHubId,
 *   minScaleUnits: 1,
 * });
 * ```
 *
 * @resource
 */
export const ExpressRouteGateway = Resource<ExpressRouteGateway>(
  "Azure.Network.ExpressRouteGateway",
);

export const ExpressRouteGatewayProvider = () =>
  Provider.succeed(
    ExpressRouteGateway,
    networkProvider<ExpressRouteGateway>()({
      label: "ExpressRoute gateway",
      nameAttr: "expressRouteGatewayName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        output.virtualHubId !== undefined &&
        !sameId(news.virtualHubId, output.virtualHubId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            expressRouteGatewayName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ExpressRouteGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteGatewayName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteExpressRouteGateway({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteGatewayName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateExpressRouteGatewayTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteGatewayName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListExpressRouteGatewayBySubscription({ subscriptionId }),
      // The PUT replaces the connection collection: carry the observed
      // connections (managed by ExpressRouteConnection).
      body: (news, { location, tags, observed }) => ({
        location,
        tags,
        properties: {
          virtualHub: { id: news.virtualHubId },
          autoScaleConfiguration: {
            bounds: { min: news.minScaleUnits ?? 1, max: news.maxScaleUnits },
          },
          allowNonVirtualWanTraffic: news.allowNonVirtualWanTraffic ?? false,
          expressRouteConnections: observed?.properties?.expressRouteConnections,
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        return (
          p?.autoScaleConfiguration?.bounds?.min !== (news.minScaleUnits ?? 1) ||
          (news.maxScaleUnits !== undefined &&
            p?.autoScaleConfiguration?.bounds?.max !== news.maxScaleUnits) ||
          (p?.allowNonVirtualWanTraffic ?? false) !==
            (news.allowNonVirtualWanTraffic ?? false)
        );
      },
      toAttrs: (path, observed) => ({
        expressRouteGatewayName: path.name,
        expressRouteGatewayId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        virtualHubId: observed.properties?.virtualHub?.id,
        connectionNames: (
          observed.properties?.expressRouteConnections ?? []
        ).map((c) => c.name),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.VirtualHub"],
    }),
  );
