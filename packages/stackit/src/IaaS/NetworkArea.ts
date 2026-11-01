import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  desiredOrganizationId,
  findOwnedByName,
  iaasName,
  labelsPatch,
  listOrganizationId,
  ownedOnly,
  readGeneration,
  resolveOrganizationId,
} from "./internal.ts";

/** The create response of a network area carried no id. */
export class NetworkAreaIdMissing extends Data.TaggedError("Stackit.IaaS.NetworkAreaIdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

export interface NetworkAreaProps {
  /**
   * Network area name. Updated in place. If omitted, a unique name is
   * generated from the app, stage and logical id.
   */
  name?: string;
  /**
   * Organization that owns the network area. Defaults to the profile's
   * organization. Changing it replaces the network area.
   */
  organizationId?: string;
  /**
   * Enable the preview routing tables feature (sets the
   * `preview/routingtables=true` label). Required for
   * {@link RoutingTable}s. Cannot be changed after creation, so changing it
   * replaces the network area.
   * @default false
   */
  routingTables?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface NetworkAreaAttributes {
  /** STACKIT network area id (UUID). */
  networkAreaId: string;
  /** Network area name. */
  name: string;
  /** Organization that owns the network area. */
  organizationId: string;
  /** Whether the preview routing tables feature is enabled. */
  routingTables: boolean;
  /** Number of projects using the network area. */
  projectCount: number;
  /** User labels (Alchemy's ownership and preview labels stripped). */
  labels: Record<string, string>;
}

export type NetworkArea = Resource<
  "Stackit.IaaS.NetworkArea",
  NetworkAreaProps,
  NetworkAreaAttributes,
  never,
  Providers
>;

/** The label STACKIT reads to enable the preview routing tables feature. */
export const ROUTING_TABLES_PREVIEW_LABEL = "preview/routingtables";

/**
 * A STACKIT network area (SNA): an organization-level routing domain that
 * projects join to share private networking. The area itself only holds a
 * name and labels; its address plan lives in a regional configuration
 * ({@link NetworkAreaRegion}), and static routes in
 * {@link NetworkAreaRoute}s.
 *
 * Network areas are free, but creating one needs organization-level
 * permissions (`iaas.network-area` admin on the organization). STACKIT
 * refuses to delete an area while projects still use it.
 *
 * ### Creating a network area
 * **Example:** Network area in the profile's organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", {
 *   labels: { team: "platform" },
 * });
 * ```
 *
 * **Example:** Network area with routing tables (preview)
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", {
 *   organizationId: "00000000-0000-0000-0000-000000000000",
 *   routingTables: true,
 * });
 * ```
 *
 * ### Configuring a region
 * **Example:** Address plan for eu01
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", {});
 * const eu01 = yield* Stackit.IaaS.NetworkAreaRegion("CorpEu01", {
 *   networkAreaId: area.networkAreaId,
 *   networkRanges: ["10.100.0.0/16"],
 *   transferNetwork: "10.255.255.0/24",
 * });
 * ```
 *
 * ### Replacement
 * Changing `organizationId` or `routingTables` creates a new network area
 * and deletes the old one, which fails while projects still use the old
 * area.
 *
 * @resource
 * @product STACKIT Network Area
 * @category IaaS
 */
export const NetworkArea = Resource<NetworkArea>("Stackit.IaaS.NetworkArea");

const toAttrs = (area: iaas.NetworkArea, organizationId: string): NetworkAreaAttributes => {
  const { [ROUTING_TABLES_PREVIEW_LABEL]: preview, ...labels } = stripInternalLabels(area.labels);
  return {
    networkAreaId: area.id ?? "",
    name: area.name,
    organizationId,
    routingTables: preview === "true",
    projectCount: area.projectCount ?? 0,
    labels,
  };
};

const getArea = (organizationId: string, areaId: string) =>
  iaas
    .getNetworkArea({ organizationId, areaId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const desiredAreaLabels = Effect.fn(function* (
  id: string,
  instanceId: string,
  news: NetworkAreaProps,
) {
  const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
  return news.routingTables === true
    ? { ...labels, [ROUTING_TABLES_PREVIEW_LABEL]: "true" }
    : labels;
});

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  organizationId: string;
  areaId: string | undefined;
  routingTables: boolean | undefined;
  instanceId: string | undefined;
}) {
  if (args.areaId !== undefined) {
    const byId = yield* getArea(args.organizationId, args.areaId);
    if (byId !== undefined) return byId;
  }
  const { items } = yield* iaas.listNetworkAreas({ organizationId: args.organizationId });
  return yield* findOwnedByName(args.id, args.name, items, {
    instanceId: args.instanceId,
    compatible: (area) =>
      args.routingTables === undefined ||
      toAttrs(area, args.organizationId).routingTables === args.routingTables,
  });
});

export const NetworkAreaProvider = () =>
  Provider.succeed(NetworkArea, {
    stables: ["networkAreaId", "organizationId", "routingTables"],

    list: Effect.fn(function* () {
      const organizationId = yield* listOrganizationId;
      if (organizationId === undefined) return [];
      const { items } = yield* iaas.listNetworkAreas({ organizationId });
      return ownedOnly(items).map((area) => toAttrs(area, organizationId));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (hasUnresolvedTrigger<NetworkAreaProps>(news, ["organizationId", "routingTables"])) {
        return { action: "replace" } as const;
      }
      const resolved = triggerProps<NetworkAreaProps>(news);
      const organizationId = yield* desiredOrganizationId(resolved);
      if (organizationId !== undefined && organizationId !== output.organizationId) {
        return { action: "replace" } as const;
      }
      if ((resolved.routingTables ?? false) !== output.routingTables) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const organizationId = yield* resolveOrganizationId(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe({
        id,
        name,
        organizationId,
        areaId: output?.networkAreaId,
        // An unset prop means the default, not "any".
        routingTables: olds === undefined ? undefined : (olds.routingTables ?? false),
        instanceId: readGeneration({ instanceId, output, previous }),
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, organizationId);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const organizationId = yield* resolveOrganizationId(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredAreaLabels(id, instanceId, news);

      let current = yield* observe({
        id,
        name,
        organizationId,
        areaId: output?.networkAreaId,
        routingTables: news.routingTables ?? false,
        instanceId,
      });
      if (current === undefined) {
        current = yield* iaas.createNetworkArea({ organizationId, name, labels });
      }
      const areaId = current.id;
      if (areaId === undefined) {
        return yield* new NetworkAreaIdMissing({
          resourceName: name,
          message: `STACKIT returned network area ${name} without an id`,
        });
      }

      const labelPatch = labelsPatch(current.labels, labels);
      if (current.name !== name || labelPatch !== undefined) {
        current = yield* iaas.partialUpdateNetworkArea({
          organizationId,
          areaId,
          name: current.name !== name ? name : undefined,
          labels: labelPatch,
        });
      }

      return toAttrs({ ...current, id: areaId }, organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { organizationId, networkAreaId } = output;
      // `Conflict` while projects or regional configurations still use the
      // area; the dependants are deleted first, so retry briefly.
      yield* iaas.deleteNetworkArea({ organizationId, areaId: networkAreaId }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT network area ${output.name}`,
        read: getArea(organizationId, networkAreaId),
        timeout: "2 minutes",
      });
    }),
  });
