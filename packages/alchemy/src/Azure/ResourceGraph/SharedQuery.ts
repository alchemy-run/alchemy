import * as resourcegraph from "@distilled.cloud/azure/resourcegraph";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Output from "../../Output.ts";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface SharedQueryProps {
  /**
   * Resource group the shared query is saved in. Changing it replaces the
   * query.
   */
  resourceGroup: string;
  /**
   * Name of the shared query, 3-64 characters of letters, digits, `-`,
   * `_`, and `.`. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the query.
   */
  name?: string;
  /**
   * Azure Resource Graph query text in the Kusto Query Language (KQL),
   * e.g. `Resources | project name, type | limit 10`.
   */
  query: string;
  /**
   * Human-readable description shown in the Resource Graph Explorer.
   */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SharedQuery extends Resource<
  "Azure.ResourceGraph.SharedQuery",
  SharedQueryProps,
  {
    /** Name of the shared query. */
    queryName: string;
    /** Resource group that holds the shared query. */
    resourceGroup: string;
    /** ARM resource ID of the shared query. */
    queryId: string;
    /** Location of the shared query (always `global`). */
    location: string;
    /** KQL query text as stored by Azure. */
    query: string;
    /** Description of the shared query. */
    description: string | undefined;
    /** Kind of query result (`basic`). */
    resultKind: string | undefined;
    /** UTC time of the last modification of the query definition. */
    timeModified: string | undefined;
    /** Optimistic-concurrency ETag of the query. */
    etag: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Resource Graph shared query — a saved KQL query over the
 * resources of your subscriptions that appears in the Resource Graph
 * Explorer and can be pinned to dashboards or shared with other users
 * through Azure RBAC.
 *
 * @see https://learn.microsoft.com/azure/governance/resource-graph/shared-query-azure-portal
 *
 * ### Saving a Query
 * **Example:** Inventory of virtual machines
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ops");
 * const query = yield* Azure.ResourceGraph.SharedQuery("vm-inventory", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "All virtual machines with their location",
 *   query:
 *     "Resources | where type =~ 'microsoft.compute/virtualmachines' | project name, location",
 * });
 * ```
 *
 * ### Tagging a Query
 * **Example:** Query with user tags
 * ```typescript
 * const query = yield* Azure.ResourceGraph.SharedQuery("untagged", {
 *   resourceGroup: group.resourceGroupName,
 *   query: "Resources | where isnull(tags) or array_length(bag_keys(tags)) == 0",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const SharedQuery = Resource<SharedQuery>(
  "Azure.ResourceGraph.SharedQuery",
);

/** Shared queries are global resources. */
const LOCATION = "global";

type ObservedQuery = resourcegraph.GetGraphQueryResponse;

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const getQuery = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    resourcegraph.GetGraphQuery({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedQuery,
): SharedQuery["Attributes"] => ({
  queryName: name,
  resourceGroup,
  queryId: observed.id ?? "",
  location: observed.location ?? LOCATION,
  query: observed.properties?.query ?? "",
  description: observed.properties?.description,
  resultKind: observed.properties?.resultKind,
  timeModified: observed.properties?.timeModified,
  etag: observed.etag,
  tags: userTags(observed.tags),
});

export const SharedQueryProvider = () =>
  Provider.succeed(SharedQuery, {
    stables: ["queryName", "resourceGroup", "queryId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resourcegraph
        .ListGraphQueryBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListGraphQueryBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((query) => {
        const group = resourceGroupOf(query.id);
        return hasAnyAlchemyTag(query.tags) &&
          group !== undefined &&
          query.name !== undefined
          ? [toAttrs(group, query.name, query)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The whole props object may be one unresolved expression.
      const fields =
        Output.isOutput(news) || Effect.isEffect(news) || Config.isConfig(news)
          ? undefined
          : news;
      if (fields === undefined) return undefined;
      // An unresolved group or name comes from an upstream resource that is
      // itself being created or replaced, so the query moves.
      if (!isResolved(fields.resourceGroup) || !isResolved(fields.name)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.queryName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.queryName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getQuery(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ResourceGraph");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.queryName ?? (yield* physicalName(id));
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getQuery(subscriptionId, resourceGroup, name);

      // Ensure + sync: the PUT is a synchronous upsert covering the query
      // text, description, and tags; skip it when nothing observed differs.
      if (
        observed === undefined ||
        observed.properties?.query !== news.query ||
        (observed.properties?.description ?? undefined) !==
          (news.description ?? undefined) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* resourcegraph.GraphQueryCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: name,
          location: LOCATION,
          properties: {
            query: news.query,
            description: news.description,
          },
          tags,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resourcegraph.DeleteGraphQuery({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.queryName,
        }),
      );
      yield* waitUntilGone(
        `shared query ${output.queryName}`,
        getQuery(subscriptionId, output.resourceGroup, output.queryName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
