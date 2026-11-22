import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { deterministicGuid, sameText } from "./Common.ts";

/** What a query relates to; the Queries pane groups and filters by it. */
export interface QueryRelated {
  /**
   * Related query categories, e.g. `["applications"]` or `["security"]`.
   * @default []
   */
  categories?: string[];
  /**
   * Related ARM resource types, e.g. `["microsoft.web/sites"]`.
   * @default []
   */
  resourceTypes?: string[];
  /**
   * Related Log Analytics solutions, e.g. `["SecurityCenter"]`.
   * @default []
   */
  solutions?: string[];
}

export interface QueryProps {
  /**
   * Resource group of the query pack.
   *
   * :::caution
   * Changing it replaces the query.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the query pack that holds the query, e.g. `pack.queryPackName`.
   *
   * :::caution
   * Changing it replaces the query.
   * :::
   */
  queryPack: string;
  /**
   * Query ID, a GUID such as `5f1a2b3c-0000-4000-8000-000000000000`.
   *
   * :::caution
   * Changing it replaces the query.
   * :::
   * @default a GUID derived from the stack, stage, and logical ID
   */
  queryId?: string;
  /** Name shown in the Queries pane, e.g. `Slow requests`. */
  displayName: string;
  /**
   * Description shown in the Queries pane.
   * @default no description
   */
  description?: string;
  /** KQL query text, e.g. `AppRequests | where DurationMs > 1000`. */
  body: string;
  /**
   * Categories, resource types, and solutions the query relates to.
   * @default nothing related
   */
  related?: QueryRelated;
  /**
   * User tags, each with a list of values, e.g. `{ team: ["platform"] }`.
   * Alchemy ownership tags are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string[]>;
}

export interface Query extends Resource<
  "Azure.LogAnalytics.Query",
  QueryProps,
  {
    /** Query ID (a GUID). */
    queryId: string;
    /** Name of the query pack that holds the query. */
    queryPack: string;
    /** Resource group of the query pack. */
    resourceGroup: string;
    /** ARM resource ID of the query. */
    queryResourceId: string;
    /** Object ID of the identity that created the query. */
    author: string | undefined;
    /** Creation time (ISO 8601). */
    timeCreated: string | undefined;
    /** Last modification time (ISO 8601). */
    timeModified: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A saved KQL query in a Log Analytics query pack
 * (`Microsoft.OperationalInsights/queryPacks/queries`). It appears in the
 * Queries pane of Log Analytics for everyone who can read the pack.
 *
 * :::caution[Changing `queryId`, `queryPack`, or `resourceGroup` replaces the query]
 * Alchemy creates the new query and deletes the old one. Change
 * `displayName`, `body`, `description`, `related`, or `tags` to update the
 * query in place.
 * :::
 *
 * :::caution[The query pack must exist first]
 * Declare an `Azure.LogAnalytics.QueryPack` and pass its `queryPackName`.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/query-packs
 *
 * ### Adding Queries to a Pack
 * **Example:** Query with categories
 * ```typescript
 * const pack = yield* Azure.LogAnalytics.QueryPack("queries");
 * const slow = yield* Azure.LogAnalytics.Query("slow-requests", {
 *   queryPack: pack.queryPackName,
 *   displayName: "Slow requests",
 *   body: "AppRequests | where DurationMs > 1000 | take 100",
 *   related: { categories: ["applications"] },
 * });
 * ```
 *
 * **Example:** Query for a resource type, with a description and tags
 * ```typescript
 * const pack = yield* Azure.LogAnalytics.QueryPack("queries");
 * yield* Azure.LogAnalytics.Query("failed-functions", {
 *   queryPack: pack.queryPackName,
 *   displayName: "Failed function runs",
 *   description: "Function invocations that failed in the last day.",
 *   body: "AppRequests | where Success == false | summarize count() by Name",
 *   related: { resourceTypes: ["microsoft.web/sites"] },
 *   tags: { team: ["platform"] },
 * });
 * ```
 *
 * @resource
 */
export const Query = GroupedResource<Query>("Azure.LogAnalytics.Query");

type ObservedQuery = operationalinsights.GetQueryResponse;
type QueryTags = { [key: string]: string[] | undefined };

const getQuery = (
  subscriptionId: string,
  resourceGroupName: string,
  queryPackName: string,
  id: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetQuery({
      subscriptionId,
      resourceGroupName,
      queryPackName,
      id,
    }),
  );

/** Single-valued tags (the ownership tags) as a flat record. */
const flatTags = (tags: QueryTags | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).flatMap(([key, values]) =>
      values?.length === 1 ? [[key, values[0]!]] : [],
    ),
  );

const toAttrs = (
  resourceGroup: string,
  queryPack: string,
  queryId: string,
  query: ObservedQuery,
): Query["Attributes"] => ({
  queryId,
  queryPack,
  resourceGroup,
  queryResourceId: query.id ?? "",
  author: query.properties?.author,
  timeCreated: query.properties?.timeCreated,
  timeModified: query.properties?.timeModified,
});

const normalize = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined && !(Array.isArray(x) && x.length === 0))
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

export const QueryProvider = () =>
  Provider.succeed(Query, {
    stables: ["queryId", "queryPack", "resourceGroup", "queryResourceId"],

    // Queries live inside a query pack; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.queryPack, output.queryPack) ||
        (news.queryId !== undefined && !sameText(news.queryId, output.queryId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const queryPack = output?.queryPack ?? olds?.queryPack;
      if (resourceGroup === undefined || queryPack === undefined) {
        return undefined;
      }
      const queryId =
        output?.queryId ?? olds?.queryId ?? (yield* deterministicGuid(id, instanceId));
      const observed = yield* getQuery(subscriptionId, resourceGroup, queryPack, queryId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, queryPack, queryId, observed);
      return (yield* hasAlchemyTags(id, flatTags(observed.properties?.tags)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, queryPack } = news;
      const queryId = news.queryId ?? output?.queryId ?? (yield* deterministicGuid(id, instanceId));
      const internal = yield* createInternalTags(id);
      const desired: operationalinsights.LogAnalyticsQueryPackQueryPropertiesInput = {
        displayName: news.displayName,
        description: news.description,
        body: news.body,
        related: news.related,
        tags: {
          ...news.tags,
          ...Object.fromEntries(Object.entries(internal).map(([key, value]) => [key, [value]])),
        },
      };

      // Observe.
      let observed = yield* getQuery(subscriptionId, resourceGroup, queryPack, queryId);

      // Ensure + sync: the PUT is a synchronous upsert of the whole query.
      const current = observed?.properties;
      if (
        observed === undefined ||
        current?.displayName !== desired.displayName ||
        (current.description ?? "") !== (desired.description ?? "") ||
        current.body !== desired.body ||
        normalize(current.related ?? {}) !== normalize(desired.related ?? {}) ||
        normalize(current.tags ?? {}) !== normalize(desired.tags)
      ) {
        observed = yield* operationalinsights.PutQuery({
          subscriptionId,
          resourceGroupName: resourceGroup,
          queryPackName: queryPack,
          id: queryId,
          properties: desired,
        });
      }

      return toAttrs(resourceGroup, queryPack, queryId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteQuery({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          queryPackName: output.queryPack,
          id: output.queryId,
        }),
      );
      yield* waitUntilGone(
        `query ${output.queryId}`,
        getQuery(subscriptionId, output.resourceGroup, output.queryPack, output.queryId),
      );
    }),
  });
