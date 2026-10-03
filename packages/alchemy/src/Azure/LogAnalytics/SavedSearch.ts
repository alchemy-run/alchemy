import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createLogAnalyticsName, sameText } from "./Common.ts";

export interface SavedSearchProps {
  /** Resource group of the workspace. Changing it replaces the search. */
  resourceGroup: string;
  /** Workspace that holds the search. Changing it replaces the search. */
  workspace: string;
  /**
   * ID (name) of the saved search. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the search.
   */
  name?: string;
  /** Category the search is listed under in the portal. */
  category: string;
  /** Display name of the search. */
  displayName: string;
  /** KQL query text. */
  query: string;
  /**
   * Function alias. When set, the search is a workspace function that
   * queries can call by this name.
   */
  functionAlias?: string;
  /**
   * Function parameters, e.g. `"minLevel:int = 3, source:string"`. Only
   * with `functionAlias`.
   */
  functionParameters?: string;
  /** Version of the query language. @default 2 */
  version?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SavedSearch extends Resource<
  "Azure.LogAnalytics.SavedSearch",
  SavedSearchProps,
  {
    /** Name (ID) of the saved search. */
    savedSearchName: string;
    /** Workspace that holds the search. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the saved search. */
    savedSearchId: string;
    /** Function alias, when the search is a function. */
    functionAlias: string | undefined;
    /** ETag of the saved search. */
    etag: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A saved search in a Log Analytics workspace: a named KQL query, or — with
 * `functionAlias` — a workspace function other queries can call.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/functions
 *
 * ### Saving a Query
 * **Example:** Saved search
 * ```typescript
 * const errors = yield* Azure.LogAnalytics.SavedSearch("errors", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   category: "App",
 *   displayName: "Recent errors",
 *   query: "AppEvents_CL | where Level == 'Error' | take 100",
 * });
 * ```
 *
 * ### Workspace Functions
 * **Example:** Function with parameters
 * ```typescript
 * const byLevel = yield* Azure.LogAnalytics.SavedSearch("by-level", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   category: "App",
 *   displayName: "Events by level",
 *   functionAlias: "EventsByLevel",
 *   functionParameters: "level:string",
 *   query: "AppEvents_CL | where Level == level",
 * });
 * ```
 *
 * @resource
 */
export const SavedSearch = Resource<SavedSearch>(
  "Azure.LogAnalytics.SavedSearch",
);

type ObservedSearch = operationalinsights.GetSavedSearchResponse;

const toTagRecord = (
  tags: ReadonlyArray<operationalinsights.Tag> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.name, tag.value]));

const getSearch = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  savedSearchId: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetSavedSearch({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      savedSearchId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  search: ObservedSearch,
): SavedSearch["Attributes"] => ({
  savedSearchName: name,
  workspace,
  resourceGroup,
  savedSearchId: search.id ?? "",
  functionAlias: search.properties.functionAlias,
  etag: search.etag,
  tags: userTags(toTagRecord(search.properties.tags)),
});

export const SavedSearchProvider = () =>
  Provider.succeed(SavedSearch, {
    stables: ["savedSearchName", "workspace", "resourceGroup", "savedSearchId"],

    // Saved searches live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.name !== undefined &&
          !sameText(news.name, output.savedSearchName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.savedSearchName ??
        olds?.name ??
        (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getSearch(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, toTagRecord(observed.properties.tags)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.savedSearchName ??
        (yield* createLogAnalyticsName(id, 63));
      const tags = yield* desiredTags(id, news.tags);
      const version = news.version ?? 2;

      // Observe.
      let observed = yield* getSearch(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );

      // Ensure + sync: the PUT is a synchronous upsert of the whole search;
      // send it only when the observed search differs.
      const current = observed?.properties;
      if (
        observed === undefined ||
        current?.category !== news.category ||
        current.displayName !== news.displayName ||
        current.query !== news.query ||
        (current.functionAlias ?? "") !== (news.functionAlias ?? "") ||
        (current.functionParameters ?? "") !==
          (news.functionParameters ?? "") ||
        (current.version ?? version) !== version ||
        tagsDiffer(toTagRecord(current.tags), tags)
      ) {
        observed = yield* operationalinsights.SavedSearchesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          savedSearchId: name,
          etag: observed?.etag,
          properties: {
            category: news.category,
            displayName: news.displayName,
            query: news.query,
            functionAlias: news.functionAlias,
            functionParameters: news.functionParameters,
            version,
            tags: Object.entries(tags).map(([key, value]) => ({
              name: key,
              value,
            })),
          },
        });
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteSavedSearch({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          savedSearchId: output.savedSearchName,
        }),
      );
      yield* waitUntilGone(
        `saved search ${output.savedSearchName}`,
        getSearch(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.savedSearchName,
        ),
      );
    }),
  });
