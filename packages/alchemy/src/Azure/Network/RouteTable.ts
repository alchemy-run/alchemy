import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetworkName,
  sameId,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface RouteTableProps {
  /**
   * Resource group the route table is created in. Changing it replaces the
   * route table.
   */
  resourceGroup: string;
  /**
   * Name of the route table: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the route table.
   */
  name?: string;
  /**
   * Azure location of the route table. Changing it replaces the route
   * table.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Stop routes learned by BGP (from VPN / ExpressRoute gateways) from
   * propagating to subnets that use this table.
   * @default false
   */
  disableBgpRoutePropagation?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface RouteTable extends Resource<
  "Azure.Network.RouteTable",
  RouteTableProps,
  {
    /** Name of the route table. */
    routeTableName: string;
    /** ARM resource ID of the route table. */
    routeTableId: string;
    /** Resource group that holds the route table. */
    resourceGroup: string;
    /** Location of the route table. */
    location: string;
    /** Immutable GUID Azure assigned to the route table. */
    resourceGuid: string | undefined;
    /** Whether BGP route propagation is disabled. */
    disableBgpRoutePropagation: boolean;
    /** IDs of the subnets associated with the route table. */
    subnetIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure route table — user-defined routes (UDRs) that override Azure's
 * default system routes for the subnets it is associated with.
 *
 * Routes are modelled by `Azure.Network.Route`; updating the table never
 * removes them. Associate the table through `Subnet.routeTableId`.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-networks-udr-overview
 *
 * ### Creating a Route Table
 * **Example:** Route table associated with a subnet
 * ```typescript
 * const routes = yield* Azure.Network.RouteTable("egress", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   routeTableId: routes.routeTableId,
 * });
 * ```
 *
 * **Example:** Route table without BGP propagation
 * ```typescript
 * const routes = yield* Azure.Network.RouteTable("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   disableBgpRoutePropagation: true,
 * });
 * ```
 *
 * @resource
 */
export const RouteTable = Resource<RouteTable>("Azure.Network.RouteTable");

type Observed = network.GetRouteTableResponse;

const getRouteTable = (
  subscriptionId: string,
  resourceGroupName: string,
  routeTableName: string,
) =>
  orUndefinedIfNotFound(
    network.GetRouteTable({
      subscriptionId,
      resourceGroupName,
      routeTableName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  table: Observed,
): RouteTable["Attributes"] => ({
  routeTableName: name,
  routeTableId: table.id ?? "",
  resourceGroup,
  location: table.location ?? "",
  resourceGuid: table.properties?.resourceGuid,
  disableBgpRoutePropagation:
    table.properties?.disableBgpRoutePropagation ?? false,
  subnetIds: (table.properties?.subnets ?? []).flatMap((subnet) =>
    subnet.id === undefined ? [] : [subnet.id],
  ),
  tags: userTags(table.tags),
});

/** Re-encode an observed route as PUT input. */
const routeInput = (route: network.Route_6): network.RouteInput_2 => {
  const p = route.properties;
  return {
    id: route.id,
    name: route.name,
    properties: p && {
      addressPrefix: p.addressPrefix,
      nextHopType: p.nextHopType,
      nextHopIpAddress: p.nextHopIpAddress,
    },
  };
};

export const RouteTableProvider = () =>
  Provider.succeed(RouteTable, {
    stables: [
      "routeTableName",
      "routeTableId",
      "resourceGroup",
      "location",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListRouteTableAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRouteTableAll", page),
          ),
        );
      return page.value.flatMap((table) => {
        const group = resourceGroupOf(table.id);
        return hasAnyAlchemyTag(table.tags) &&
          group !== undefined &&
          table.name !== undefined
          ? [toAttrs(group, table.name, table)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.routeTableName)) ||
        (news.location !== undefined && !sameId(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.routeTableName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getRouteTable(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.routeTableName ?? (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const disableBgpRoutePropagation =
        news.disableBgpRoutePropagation ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        routeTableName: name,
      };
      const get = getRouteTable(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the route collection, so it carries
      // the observed routes (modelled as Route resources).
      if (
        observed === undefined ||
        (observed.properties?.disableBgpRoutePropagation ?? false) !==
          disableBgpRoutePropagation
      ) {
        // Each attempt re-reads the routes: a busy retry with a stale copy
        // would revert a concurrent Route write.
        yield* Effect.gen(function* () {
          const current = yield* get;
          yield* network.RouteTablesCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              disableBgpRoutePropagation,
              routes: current?.properties?.routes?.map(routeInput),
            },
          });
        }).pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* network
          .UpdateRouteTableTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(`route table ${name}`, get);
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteRouteTable({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          routeTableName: output.routeTableName,
        }),
      ).pipe(Effect.retry(whileInUse(["RouteTableInUse"])));
      yield* waitNetworkGone(
        `route table ${output.routeTableName}`,
        getRouteTable(
          subscriptionId,
          output.resourceGroup,
          output.routeTableName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
