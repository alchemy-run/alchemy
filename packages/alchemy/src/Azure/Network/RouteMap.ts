import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import { hubOwnerTags } from "./virtualHubShared.ts";

/** Route attributes a criterion matches or an action applies. */
export interface RouteMapValues {
  /** Route prefixes, e.g. `["10.0.0.0/16"]`. */
  routePrefix?: string[];
  /** BGP communities, e.g. `["65001:100"]`. */
  community?: string[];
  /** AS paths, e.g. `["65001"]`. */
  asPath?: string[];
}

/** A route-map rule: match criteria, actions, and what happens next. */
export interface RouteMapRuleSpec {
  /** Name of the rule. */
  name: string;
  /** Conditions a route must satisfy (all of them). */
  matchCriteria: (RouteMapValues & {
    /** How the values are compared. */
    matchCondition: "Contains" | "Equals" | "NotContains" | "NotEquals";
  })[];
  /** Modifications applied to matching routes. */
  actions: {
    /** Action type. */
    type: "Add" | "Remove" | "Replace" | "Drop";
    /** Values the action adds, removes, or replaces with. */
    parameters?: RouteMapValues[];
  }[];
  /**
   * Whether to evaluate the next rule after a match.
   * @default "Continue"
   */
  nextStepIfMatched?: "Continue" | "Terminate";
}

export interface RouteMapProps {
  /** Resource group of the virtual hub. Changing it replaces the map. */
  resourceGroup: string;
  /** Name of the parent virtual hub. Changing it replaces the map. */
  virtualHub: string;
  /**
   * Name of the route map. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the map.
   */
  name?: string;
  /** Ordered rules of the map. */
  rules: RouteMapRuleSpec[];
}

export interface RouteMap extends Resource<
  "Azure.Network.RouteMap",
  RouteMapProps,
  {
    /** Name of the route map. */
    routeMapName: string;
    /** ARM resource ID of the route map. */
    routeMapId: string;
    /** Name of the parent virtual hub. */
    virtualHub: string;
    /** Resource group of the virtual hub. */
    resourceGroup: string;
    /** IDs of the connections applying the map to inbound routes. */
    associatedInboundConnections: string[];
    /** IDs of the connections applying the map to outbound routes. */
    associatedOutboundConnections: string[];
  },
  never,
  Providers
> {}

/**
 * A route map in a Standard Azure Virtual WAN hub — filters and rewrites
 * BGP routes (prefixes, communities, AS paths) on the connections that
 * reference it (`routing.inboundRouteMapId` / `outboundRouteMapId`).
 * Route maps carry no tags: ownership follows the parent hub.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/route-maps-about
 *
 * ### Creating a Route Map
 * **Example:** Drop a prefix and tag everything else
 * ```typescript
 * const map = yield* Azure.Network.RouteMap("filter", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   rules: [
 *     {
 *       name: "drop-test",
 *       matchCriteria: [{ matchCondition: "Contains", routePrefix: ["10.99.0.0/16"] }],
 *       actions: [{ type: "Drop" }],
 *       nextStepIfMatched: "Terminate",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RouteMap = Resource<RouteMap>("Azure.Network.RouteMap");

export const RouteMapProvider = () =>
  Provider.succeed(
    RouteMap,
    networkProvider<RouteMap>()({
      label: "route map",
      nameAttr: "routeMapName",
      parents: ["virtualHub"],
      tracked: false,
      slow: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetRouteMap({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.virtualHub!,
            routeMapName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.RouteMapsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          routeMapName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteRouteMap({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          routeMapName: path.name,
        }),
      ownerTags: hubOwnerTags,
      body: (news) => ({
        properties: {
          rules: news.rules.map((rule) => ({
            name: rule.name,
            matchCriteria: rule.matchCriteria,
            actions: rule.actions.map((action) => ({
              type: action.type,
              parameters: action.parameters ?? [],
            })),
            nextStepIfMatched: rule.nextStepIfMatched ?? "Continue",
          })),
        },
      }),
      toAttrs: (path, observed) => ({
        routeMapName: path.name,
        routeMapId: observed.id ?? "",
        virtualHub: path.virtualHub!,
        resourceGroup: path.resourceGroup,
        associatedInboundConnections: [
          ...(observed.properties?.associatedInboundConnections ?? []),
        ],
        associatedOutboundConnections: [
          ...(observed.properties?.associatedOutboundConnections ?? []),
        ],
      }),
      dependsOn: ["Azure.Network.VirtualHub"],
    }),
  );
