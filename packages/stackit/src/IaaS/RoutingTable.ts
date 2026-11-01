import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredOrganizationId,
  findOwnedByName,
  iaasName,
  labelsPatch,
  listOrganizationId,
  ownedOnly,
  readGeneration,
  resolveOrganizationId,
} from "./internal.ts";

/** The create response of a routing table carried no id. */
export class RoutingTableIdMissing extends Data.TaggedError("Stackit.IaaS.RoutingTableIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

export interface RoutingTableProps {
  /**
   * Network area the routing table belongs to. The area must have been
   * created with `routingTables: true`. Changing it replaces the table.
   */
  networkAreaId: string;
  /**
   * Organization that owns the network area. Defaults to the profile's
   * organization. Changing it replaces the table.
   */
  organizationId?: string;
  /**
   * Region of the routing table. Defaults to the profile's region.
   * Changing it replaces the table.
   */
  region?: string;
  /**
   * Routing table name. Updated in place. If omitted, a unique name is
   * generated from the app, stage and logical id.
   */
  name?: string;
  /** Free-text description. Updated in place; not managed when omitted. */
  description?: string;
  /**
   * Whether routes learned dynamically (e.g. from VPN gateways) are added
   * to the table. Updated in place.
   * @default true
   */
  dynamicRoutes?: boolean;
  /**
   * Whether the system routes (the routes between the area's networks and
   * to the internet) are part of the table. Updated in place.
   * @default true
   */
  systemRoutes?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface RoutingTableAttributes {
  /** Routing table id (UUID). */
  routingTableId: string;
  /** Organization that owns the network area. */
  organizationId: string;
  /** Network area the table belongs to. */
  networkAreaId: string;
  /** Region of the table. */
  region: string;
  /** Routing table name. */
  name: string;
  /** Description, if any. */
  description: string | undefined;
  /** Whether dynamic routes are added. */
  dynamicRoutes: boolean;
  /** Whether system routes are part of the table. */
  systemRoutes: boolean;
  /** Whether this is the area's default routing table. */
  default: boolean;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type RoutingTable = Resource<
  "Stackit.IaaS.RoutingTable",
  RoutingTableProps,
  RoutingTableAttributes,
  never,
  Providers
>;

/**
 * A routing table of a STACKIT {@link NetworkArea} in one region (preview
 * feature: the area must be created with `routingTables: true`). Networks
 * pick a routing table with their `routingTableId`; their routes are
 * {@link RoutingTableRoute}s.
 *
 * Every property except the area, organization and region is updated in
 * place.
 *
 * ### Creating a routing table
 * **Example:** A routing table for isolated workloads
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", { routingTables: true });
 * const regional = yield* Stackit.IaaS.NetworkAreaRegion("CorpRegion", {
 *   networkAreaId: area.networkAreaId,
 *   networkRanges: ["10.100.0.0/16"],
 *   transferNetwork: "10.255.255.0/24",
 * });
 * const table = yield* Stackit.IaaS.RoutingTable("Isolated", {
 *   networkAreaId: regional.networkAreaId,
 *   description: "No internet access",
 *   systemRoutes: false,
 * });
 * ```
 *
 * ### Using a routing table
 * **Example:** Attach a network to the table
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", { routingTables: true });
 * const table = yield* Stackit.IaaS.RoutingTable("Isolated", {
 *   networkAreaId: area.networkAreaId,
 * });
 * const network = yield* Stackit.IaaS.Network("Workloads", {
 *   ipv4: { prefixLength: 24 },
 *   routingTableId: table.routingTableId,
 * });
 * ```
 *
 * ### Replacement
 * Changing `networkAreaId`, `organizationId` or `region` creates a new
 * table before deleting the old one; networks using the old table must
 * move to the new one first.
 *
 * @resource
 * @product STACKIT Network Area
 * @category IaaS
 */
export const RoutingTable = Resource<RoutingTable>("Stackit.IaaS.RoutingTable");

interface AreaScope {
  organizationId: string;
  networkAreaId: string;
  region: string;
}

const request = (scope: AreaScope) => ({
  organizationId: scope.organizationId,
  areaId: scope.networkAreaId,
  region: scope.region,
});

const toAttrs = (table: iaas.RoutingTable, scope: AreaScope): RoutingTableAttributes => ({
  routingTableId: table.id ?? "",
  ...scope,
  name: table.name,
  description: table.description,
  dynamicRoutes: table.dynamicRoutes ?? true,
  systemRoutes: table.systemRoutes ?? true,
  default: table.default ?? false,
  labels: stripInternalLabels(table.labels),
});

const getTable = (scope: AreaScope, routingTableId: string) =>
  iaas
    .getRoutingTableOfArea({ ...request(scope), routingTableId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const resolveScope = Effect.fn(function* (
  news: RoutingTableProps | undefined,
  output: RoutingTableAttributes | undefined,
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
  name: string,
  scope: AreaScope,
  routingTableId: string | undefined,
  instanceId: string | undefined,
) {
  if (routingTableId !== undefined) {
    const byId = yield* getTable(scope, routingTableId);
    if (byId !== undefined) return byId;
  }
  const { items } = yield* iaas.listRoutingTablesOfArea(request(scope));
  return yield* findOwnedByName(id, name, items, { instanceId });
});

export const RoutingTableProvider = () =>
  Provider.succeed(RoutingTable, {
    stables: ["routingTableId", "organizationId", "networkAreaId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.NetworkAreaRegion", "Stackit.IaaS.NetworkArea"] },

    list: Effect.fn(function* () {
      const organizationId = yield* listOrganizationId;
      if (organizationId === undefined) return [];
      const env = yield* StackitEnvironment.current;
      const { items: areas } = yield* iaas.listNetworkAreas({ organizationId });
      const attrs: RoutingTableAttributes[] = [];
      for (const area of ownedOnly(areas)) {
        if (area.id === undefined) continue;
        const scope = { organizationId, networkAreaId: area.id, region: env.region };
        // An area not configured in this region (or without the routing
        // tables preview) has no tables there.
        const { items } = yield* iaas
          .listRoutingTablesOfArea(request(scope))
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ items: [] })));
        attrs.push(
          ...ownedOnly(items)
            .filter((table) => table.default !== true)
            .map((table) => toAttrs(table, scope)),
        );
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<RoutingTableProps>(news, ["organizationId", "networkAreaId", "region"])
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      const organizationId = yield* desiredOrganizationId(news);
      if (
        (organizationId !== undefined && organizationId !== output.organizationId) ||
        news.networkAreaId !== output.networkAreaId ||
        (news.region ?? env.region) !== output.region
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      if (olds === undefined && output === undefined) return undefined;
      const scope = yield* resolveScope(olds, output);
      if (scope.networkAreaId === "") return undefined;
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe(
        id,
        name,
        scope,
        output?.routingTableId,
        readGeneration({ instanceId, output, previous }),
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const dynamicRoutes = news.dynamicRoutes ?? true;
      const systemRoutes = news.systemRoutes ?? true;

      let current = yield* observe(id, name, scope, output?.routingTableId, instanceId);
      if (current === undefined) {
        current = yield* iaas.addRoutingTableToArea({
          ...request(scope),
          name,
          description: news.description,
          dynamicRoutes,
          systemRoutes,
          labels,
        });
      }
      const routingTableId = current.id;
      if (routingTableId === undefined) {
        return yield* new RoutingTableIdMissing({
          resourceName: name,
          message: `STACKIT returned routing table ${name} without an id`,
        });
      }

      const patch: Omit<
        iaas.UpdateRoutingTableOfAreaRequest,
        "organizationId" | "areaId" | "region" | "routingTableId"
      > = {};
      if (current.name !== name) patch.name = name;
      if (news.description !== undefined && current.description !== news.description) {
        patch.description = news.description;
      }
      if ((current.dynamicRoutes ?? true) !== dynamicRoutes) patch.dynamicRoutes = dynamicRoutes;
      if ((current.systemRoutes ?? true) !== systemRoutes) patch.systemRoutes = systemRoutes;
      const labelPatch = labelsPatch(current.labels, labels);
      if (labelPatch !== undefined) patch.labels = labelPatch;
      if (Object.keys(patch).length > 0) {
        current = yield* iaas.updateRoutingTableOfArea({
          ...request(scope),
          routingTableId,
          ...patch,
        });
      }

      return toAttrs({ ...current, id: routingTableId }, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iaas
        .deleteRoutingTableFromArea({
          ...request(output),
          routingTableId: output.routingTableId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT routing table ${output.name}`,
        read: getTable(output, output.routingTableId),
        timeout: "1 minute",
      });
    }),
  });
