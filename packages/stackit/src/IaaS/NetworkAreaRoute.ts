import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
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

/** A route create call returned no route matching the request. */
export class RouteNotReturned extends Data.TaggedError("Stackit.IaaS.RouteNotReturned")<{
  readonly route: string;
  readonly message: string;
}> {}

export interface NetworkAreaRouteProps {
  /** Network area the route belongs to. Changing it replaces the route. */
  networkAreaId: string;
  /**
   * Organization that owns the network area. Defaults to the profile's
   * organization. Changing it replaces the route.
   */
  organizationId?: string;
  /**
   * Region the route applies in (the area must be configured there, see
   * {@link NetworkAreaRegion}). Defaults to the profile's region. Changing
   * it replaces the route.
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

export interface NetworkAreaRouteAttributes {
  /** Route id (UUID). */
  routeId: string;
  /** Organization that owns the network area. */
  organizationId: string;
  /** Network area the route belongs to. */
  networkAreaId: string;
  /** Region the route applies in. */
  region: string;
  /** Destination of the route. */
  destination: RouteDestination;
  /** Next hop of the route. */
  nexthop: RouteNexthop;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type NetworkAreaRoute = Resource<
  "Stackit.IaaS.NetworkAreaRoute",
  NetworkAreaRouteProps,
  NetworkAreaRouteAttributes,
  never,
  Providers
>;

/**
 * A static route of a STACKIT {@link NetworkArea} in one region, e.g. to
 * send a prefix to a VPN appliance inside the area.
 *
 * Only labels are mutable; changing the destination or the next hop
 * replaces the route.
 *
 * ### Creating a route
 * **Example:** Route a prefix to an appliance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", {});
 * const regional = yield* Stackit.IaaS.NetworkAreaRegion("CorpRegion", {
 *   networkAreaId: area.networkAreaId,
 *   networkRanges: ["10.100.0.0/16"],
 *   transferNetwork: "10.255.255.0/24",
 * });
 * const route = yield* Stackit.IaaS.NetworkAreaRoute("OnPrem", {
 *   networkAreaId: regional.networkAreaId,
 *   destination: { type: "cidrv4", value: "192.168.0.0/16" },
 *   nexthop: { type: "ipv4", value: "10.100.0.10" },
 *   labels: { purpose: "vpn" },
 * });
 * ```
 *
 * **Example:** Blackhole a prefix
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", {});
 * yield* Stackit.IaaS.NetworkAreaRoute("Drop", {
 *   networkAreaId: area.networkAreaId,
 *   destination: { type: "cidrv4", value: "10.66.0.0/16" },
 *   nexthop: { type: "blackhole" },
 * });
 * ```
 *
 * ### Replacement
 * Changing `destination`, `nexthop`, `networkAreaId`, `organizationId` or
 * `region` creates the new route before deleting the old one.
 *
 * @resource
 * @product STACKIT Network Area
 * @category IaaS
 */
export const NetworkAreaRoute = Resource<NetworkAreaRoute>("Stackit.IaaS.NetworkAreaRoute");

interface AreaScope {
  organizationId: string;
  networkAreaId: string;
  region: string;
}

const toAttrs = (route: iaas.Route, scope: AreaScope): NetworkAreaRouteAttributes => ({
  routeId: route.id ?? "",
  ...scope,
  destination: toRouteDestination(route.destination),
  nexthop: toRouteNexthop(route.nexthop),
  labels: stripInternalLabels(route.labels),
});

const request = (scope: AreaScope) => ({
  organizationId: scope.organizationId,
  areaId: scope.networkAreaId,
  region: scope.region,
});

const getRoute = (scope: AreaScope, routeId: string) =>
  iaas
    .getNetworkAreaRoute({ ...request(scope), routeId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const resolveScope = Effect.fn(function* (
  news: NetworkAreaRouteProps | undefined,
  output: NetworkAreaRouteAttributes | undefined,
) {
  const organizationId = yield* resolveOrganizationId(news, output);
  const env = yield* StackitEnvironment.current;
  return {
    organizationId,
    networkAreaId: news?.networkAreaId ?? output?.networkAreaId ?? "",
    region: news?.region ?? output?.region ?? env.region,
  } satisfies AreaScope;
});

const observe = Effect.fn(function* (
  id: string,
  scope: AreaScope,
  routeId: string | undefined,
  desired: { destination: RouteDestination; nexthop: RouteNexthop } | undefined,
) {
  if (routeId !== undefined) {
    const byId = yield* getRoute(scope, routeId);
    if (byId !== undefined) return byId;
  }
  if (desired === undefined) return undefined;
  const { items } = yield* iaas
    .listNetworkAreaRoutes(request(scope))
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ items: [] })));
  return yield* findOwnedRoute(id, desired, items);
});

export const NetworkAreaRouteProvider = () =>
  Provider.succeed(NetworkAreaRoute, {
    stables: ["routeId", "organizationId", "networkAreaId", "region", "destination", "nexthop"],
    nuke: { dependsOn: ["Stackit.IaaS.NetworkAreaRegion", "Stackit.IaaS.NetworkArea"] },

    list: Effect.fn(function* () {
      const organizationId = yield* listOrganizationId;
      if (organizationId === undefined) return [];
      const env = yield* StackitEnvironment.current;
      const { items: areas } = yield* iaas.listNetworkAreas({ organizationId });
      const attrs: NetworkAreaRouteAttributes[] = [];
      for (const area of ownedOnly(areas)) {
        if (area.id === undefined) continue;
        const scope = { organizationId, networkAreaId: area.id, region: env.region };
        // An area not configured in this region has no routes there.
        const { items } = yield* iaas
          .listNetworkAreaRoutes(request(scope))
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ items: [] })));
        attrs.push(...ownedOnly(items).map((route) => toAttrs(route, scope)));
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
      if (scope.networkAreaId === "") return undefined;
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
        const { items } = yield* iaas.createNetworkAreaRoute({
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
        current = yield* iaas.updateNetworkAreaRoute({
          ...request(scope),
          routeId: current.id,
          labels: labelPatch,
        });
      }
      return toAttrs(current, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iaas
        .deleteNetworkAreaRoute({ ...request(output), routeId: output.routeId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT network area route ${output.routeId}`,
        read: getRoute(output, output.routeId),
        timeout: "1 minute",
      });
    }),
  });
