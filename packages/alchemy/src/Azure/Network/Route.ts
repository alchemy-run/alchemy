import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  convergeChild,
  createNetworkName,
  parentOwned,
  sameId,
  waitNetworkGone,
  whileNetworkBusy,
} from "./common.ts";

export type RouteNextHopType =
  | "VirtualNetworkGateway"
  | "VnetLocal"
  | "Internet"
  | "VirtualAppliance"
  | "None";

export interface RouteProps {
  /** Resource group of the route table. Changing it replaces the route. */
  resourceGroup: string;
  /** Name of the parent route table. Changing it replaces the route. */
  routeTable: string;
  /**
   * Name of the route: 1-80 letters, digits, `_`, `.`, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the route.
   */
  name?: string;
  /**
   * Destination of the route: a CIDR (e.g. `0.0.0.0/0`) or a service tag
   * (e.g. `AzureCloud`).
   */
  addressPrefix: string;
  /** Where matching packets are sent. */
  nextHopType: RouteNextHopType;
  /**
   * IP address of the next hop. Required (and only allowed) when
   * `nextHopType` is `VirtualAppliance`.
   */
  nextHopIpAddress?: string;
}

export interface Route extends Resource<
  "Azure.Network.Route",
  RouteProps,
  {
    /** Name of the route. */
    routeName: string;
    /** ARM resource ID of the route. */
    routeId: string;
    /** Name of the parent route table. */
    routeTable: string;
    /** Resource group of the route table. */
    resourceGroup: string;
    /** Destination CIDR or service tag. */
    addressPrefix: string | undefined;
    /** Next hop type. */
    nextHopType: string;
    /** Next hop IP address (`VirtualAppliance` routes). */
    nextHopIpAddress: string | undefined;
    /** Whether the route overrides overlapping BGP routes. */
    hasBgpOverride: boolean;
  },
  never,
  Providers
> {}

/**
 * A user-defined route in an Azure route table. Routes override Azure's
 * system routes for every subnet the table is associated with — e.g. force
 * internet-bound traffic through a firewall appliance.
 *
 * Routes carry no tags: ownership follows the parent route table.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-networks-udr-overview
 *
 * ### Creating a Route
 * **Example:** Send all outbound traffic through an appliance
 * ```typescript
 * const table = yield* Azure.Network.RouteTable("egress", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Network.Route("default", {
 *   resourceGroup: group.resourceGroupName,
 *   routeTable: table.routeTableName,
 *   addressPrefix: "0.0.0.0/0",
 *   nextHopType: "VirtualAppliance",
 *   nextHopIpAddress: "10.0.0.4",
 * });
 * ```
 *
 * **Example:** Black-hole a range
 * ```typescript
 * yield* Azure.Network.Route("drop", {
 *   resourceGroup: group.resourceGroupName,
 *   routeTable: table.routeTableName,
 *   addressPrefix: "192.168.0.0/16",
 *   nextHopType: "None",
 * });
 * ```
 *
 * @resource
 */
export const Route = Resource<Route>("Azure.Network.Route");

type Observed = network.GetRouteResponse;

const getRoute = (
  subscriptionId: string,
  resourceGroupName: string,
  routeTableName: string,
  routeName: string,
) =>
  orUndefinedIfNotFound(
    network.GetRoute({
      subscriptionId,
      resourceGroupName,
      routeTableName,
      routeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  routeTable: string,
  name: string,
  route: Observed,
): Route["Attributes"] => ({
  routeName: name,
  routeId: route.id ?? "",
  routeTable,
  resourceGroup,
  addressPrefix: route.properties?.addressPrefix,
  nextHopType: route.properties?.nextHopType ?? "",
  nextHopIpAddress: route.properties?.nextHopIpAddress,
  hasBgpOverride: route.properties?.hasBgpOverride ?? false,
});

export const RouteProvider = () =>
  Provider.succeed(Route, {
    stables: ["routeName", "routeId", "routeTable", "resourceGroup"],

    // Routes live inside a route table; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.routeTable, output.routeTable) ||
        (news.name !== undefined && !sameId(news.name, output.routeName))
      ) {
        // Address prefixes are unique per route table: delete the old route first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const routeTable = output?.routeTable ?? olds?.routeTable;
      if (resourceGroup === undefined || routeTable === undefined) {
        return undefined;
      }
      const name =
        output?.routeName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getRoute(
        subscriptionId,
        resourceGroup,
        routeTable,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, routeTable, name, observed);
      const table = yield* orUndefinedIfNotFound(
        network.GetRouteTable({
          subscriptionId,
          resourceGroupName: resourceGroup,
          routeTableName: routeTable,
        }),
      );
      return (yield* parentOwned(table?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, routeTable } = news;
      const name =
        news.name ?? output?.routeName ?? (yield* createNetworkName(id));
      const get = getRoute(subscriptionId, resourceGroup, routeTable, name);

      // Observe -> ensure + sync (one PUT when missing or any field
      // drifts), re-checked after a concurrent route-table update settles.
      const observed = yield* convergeChild({
        label: `route ${routeTable}/${name}`,
        get,
        getParent: orUndefinedIfNotFound(
          network.GetRouteTable({
            subscriptionId,
            resourceGroupName: resourceGroup,
            routeTableName: routeTable,
          }),
        ),
        drifted: (route) =>
          route === undefined ||
          route.properties?.addressPrefix !== news.addressPrefix ||
          route.properties?.nextHopType !== news.nextHopType ||
          route.properties?.nextHopIpAddress !== news.nextHopIpAddress,
        apply: network
          .RoutesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            routeTableName: routeTable,
            routeName: name,
            properties: {
              addressPrefix: news.addressPrefix,
              nextHopType: news.nextHopType,
              nextHopIpAddress: news.nextHopIpAddress,
            },
          })
          .pipe(Effect.retry(whileNetworkBusy)),
      });
      return toAttrs(resourceGroup, routeTable, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteRoute({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          routeTableName: output.routeTable,
          routeName: output.routeName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGone(
        `route ${output.routeTable}/${output.routeName}`,
        getRoute(
          subscriptionId,
          output.resourceGroup,
          output.routeTable,
          output.routeName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Network.RouteTable", "Azure.Resources.ResourceGroup"],
    },
  });
