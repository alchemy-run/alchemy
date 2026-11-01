import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredOrganizationId,
  findOwnedRoute,
  labelsPatch,
  listOrganizationId,
  ownedOnly,
  resolveOrganizationId,
  routeIdentityChanged,
  routeKey,
  toRouteDestination,
  toRouteNexthop,
  type RouteDestination,
  type RouteNexthop,
} from "./internal.ts";
import { RouteNotReturned } from "./NetworkAreaRoute.ts";

export interface RoutingTableRouteProps {
  /** Network area of the routing table. Changing it replaces the route. */
  networkAreaId: string;
  /** Routing table the route belongs to. Changing it replaces the route. */
  routingTableId: string;
  /**
   * Organization that owns the network area. Defaults to the profile's
   * organization. Changing it replaces the route.
   */
  organizationId?: string;
  /**
   * Region of the routing table. Defaults to the profile's region.
   * Changing it replaces the route.
   */
  region?: string;
  /** Destination of the route. Changing it replaces the route. */
  destination: RouteDestination;
  /** Next hop of the route. Changing it replaces the route. */
  nexthop: RouteNexthop;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically. Updated in
   * place.
   */
  labels?: Record<string, string>;
}

export interface RoutingTableRouteAttributes {
  /** Route id (UUID). */
  routeId: string;
  /** Organization that owns the network area. */
  organizationId: string;
  /** Network area of the routing table. */
  networkAreaId: string;
  /** Routing table the route belongs to. */
  routingTableId: string;
  /** Region of the routing table. */
  region: string;
  /** Destination of the route. */
  destination: RouteDestination;
  /** Next hop of the route. */
  nexthop: RouteNexthop;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type RoutingTableRoute = Resource<
  "Stackit.IaaS.RoutingTableRoute",
  RoutingTableRouteProps,
  RoutingTableRouteAttributes,
  never,
  Providers
>;

/**
 * A route in a STACKIT {@link RoutingTable} (preview routing tables
 * feature). Networks that use the routing table get the route.
 *
 * Only labels are mutable; changing the destination or the next hop
 * replaces the route.
 *
 * ### Creating a route
 * **Example:** Default route to an appliance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", { routingTables: true });
 * const table = yield* Stackit.IaaS.RoutingTable("ViaFirewall", {
 *   networkAreaId: area.networkAreaId,
 *   systemRoutes: false,
 * });
 * const route = yield* Stackit.IaaS.RoutingTableRoute("Default", {
 *   networkAreaId: table.networkAreaId,
 *   routingTableId: table.routingTableId,
 *   destination: { type: "cidrv4", value: "0.0.0.0/0" },
 *   nexthop: { type: "ipv4", value: "10.100.0.5" },
 * });
 * ```
 *
 * **Example:** Route to the internet
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", { routingTables: true });
 * const table = yield* Stackit.IaaS.RoutingTable("Egress", {
 *   networkAreaId: area.networkAreaId,
 * });
 * yield* Stackit.IaaS.RoutingTableRoute("Internet", {
 *   networkAreaId: table.networkAreaId,
 *   routingTableId: table.routingTableId,
 *   destination: { type: "cidrv4", value: "0.0.0.0/0" },
 *   nexthop: { type: "internet" },
 * });
 * ```
 *
 * ### Replacement
 * Changing `destination`, `nexthop`, `routingTableId`, `networkAreaId`,
 * `organizationId` or `region` creates the new route before deleting the
 * old one.
 *
 * @resource
 * @product STACKIT Network Area
 * @category IaaS
 */
export const RoutingTableRoute = Resource<RoutingTableRoute>("Stackit.IaaS.RoutingTableRoute");

interface TableScope {
  organizationId: string;
  networkAreaId: string;
  routingTableId: string;
  region: string;
}

const request = (scope: TableScope) => ({
  organizationId: scope.organizationId,
  areaId: scope.networkAreaId,
  region: scope.region,
  routingTableId: scope.routingTableId,
});

const toAttrs = (route: iaas.Route, scope: TableScope): RoutingTableRouteAttributes => ({
  routeId: route.id ?? "",
  ...scope,
  destination: toRouteDestination(route.destination),
  nexthop: toRouteNexthop(route.nexthop),
  labels: stripInternalLabels(route.labels),
});

const getRoute = (scope: TableScope, routeId: string) =>
  iaas
    .getRouteOfRoutingTable({ ...request(scope), routeId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const resolveScope = Effect.fn(function* (
  news: RoutingTableRouteProps | undefined,
  output: RoutingTableRouteAttributes | undefined,
) {
  const organizationId = yield* resolveOrganizationId(news, output);
  const env = yield* StackitEnvironment.current;
  return {
    organizationId,
    networkAreaId: news?.networkAreaId ?? output?.networkAreaId ?? "",
    routingTableId: news?.routingTableId ?? output?.routingTableId ?? "",
    region: news?.region ?? output?.region ?? env.region,
  } satisfies TableScope;
});

const observe = Effect.fn(function* (
  id: string,
  scope: TableScope,
  routeId: string | undefined,
  desired: { destination: RouteDestination; nexthop: RouteNexthop } | undefined,
) {
  if (routeId !== undefined) {
    const byId = yield* getRoute(scope, routeId);
    if (byId !== undefined) return byId;
  }
  if (desired === undefined) return undefined;
  const { items } = yield* iaas
    .listRoutesOfRoutingTable(request(scope))
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ items: [] })));
  return yield* findOwnedRoute(id, desired, items);
});

export const RoutingTableRouteProvider = () =>
  Provider.succeed(RoutingTableRoute, {
    stables: [
      "routeId",
      "organizationId",
      "networkAreaId",
      "routingTableId",
      "region",
      "destination",
      "nexthop",
    ],
    nuke: { dependsOn: ["Stackit.IaaS.RoutingTable", "Stackit.IaaS.NetworkArea*"] },

    list: Effect.fn(function* () {
      const organizationId = yield* listOrganizationId;
      if (organizationId === undefined) return [];
      const env = yield* StackitEnvironment.current;
      const { items: areas } = yield* iaas.listNetworkAreas({ organizationId });
      const attrs: RoutingTableRouteAttributes[] = [];
      for (const area of ownedOnly(areas)) {
        if (area.id === undefined) continue;
        const areaRequest = { organizationId, areaId: area.id, region: env.region };
        const { items: tables } = yield* iaas
          .listRoutingTablesOfArea(areaRequest)
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ items: [] })));
        for (const table of tables) {
          if (table.id === undefined) continue;
          const scope = {
            organizationId,
            networkAreaId: area.id,
            routingTableId: table.id,
            region: env.region,
          };
          const { items } = yield* iaas.listRoutesOfRoutingTable(request(scope));
          attrs.push(...ownedOnly(items).map((route) => toAttrs(route, scope)));
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      const organizationId = yield* desiredOrganizationId(news);
      if (
        (organizationId !== undefined && organizationId !== output.organizationId) ||
        news.networkAreaId !== output.networkAreaId ||
        news.routingTableId !== output.routingTableId ||
        (news.region ?? env.region) !== output.region ||
        routeIdentityChanged(news, output)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      if (olds === undefined && output === undefined) return undefined;
      const scope = yield* resolveScope(olds, output);
      if (scope.networkAreaId === "" || scope.routingTableId === "") return undefined;
      const observed = yield* observe(id, scope, output?.routeId, olds ?? output);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveScope(news, output);
      const labels = yield* desiredLabels(id, news.labels);

      let current = yield* observe(id, scope, output?.routeId, news);
      if (current === undefined) {
        const { items } = yield* iaas.addRoutesToRoutingTable({
          ...request(scope),
          items: [{ destination: news.destination, nexthop: news.nexthop, labels }],
        });
        current = items.find((route) => routeKey(route) === routeKey(news)) ?? items[0];
        if (current === undefined) {
          return yield* new RouteNotReturned({
            route: routeKey(news),
            message: `STACKIT returned no route for ${routeKey(news)}`,
          });
        }
      }

      const labelPatch = labelsPatch(current.labels, labels);
      if (labelPatch !== undefined && current.id !== undefined) {
        current = yield* iaas.updateRouteOfRoutingTable({
          ...request(scope),
          routeId: current.id,
          labels: labelPatch,
        });
      }
      return toAttrs(current, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iaas
        .deleteRouteFromRoutingTable({ ...request(output), routeId: output.routeId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT routing table route ${output.routeId}`,
        read: getRoute(output, output.routeId),
        timeout: "1 minute",
      });
    }),
  });
