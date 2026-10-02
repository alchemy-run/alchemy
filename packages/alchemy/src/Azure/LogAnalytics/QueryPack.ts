import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createLogAnalyticsName, sameText } from "./Common.ts";

export interface QueryPackProps {
  /**
   * Resource group the query pack is created in. Changing it replaces the
   * query pack.
   */
  resourceGroup: string;
  /**
   * Query pack name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the query pack.
   */
  name?: string;
  /**
   * Azure location of the query pack. Changing it replaces the query pack.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface QueryPack extends Resource<
  "Azure.LogAnalytics.QueryPack",
  QueryPackProps,
  {
    /** Name of the query pack. */
    queryPackName: string;
    /** Resource group that holds the query pack. */
    resourceGroup: string;
    /** ARM resource ID of the query pack. */
    queryPackId: string;
    /** GUID of the query pack (`properties.queryPackId`). */
    queryPackGuid: string;
    /** Location of the query pack. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Log Analytics query pack — a shareable collection of KQL queries that
 * shows up in the Queries pane of every Log Analytics workspace the user
 * can access. Add queries with `Azure.LogAnalytics.Query`.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/query-packs
 *
 * ### Creating a Query Pack
 * **Example:** Query pack
 * ```typescript
 * const pack = yield* Azure.LogAnalytics.QueryPack("queries", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const QueryPack = Resource<QueryPack>("Azure.LogAnalytics.QueryPack");

type ObservedQueryPack = operationalinsights.GetQueryPackResponse;

const getQueryPack = (
  subscriptionId: string,
  resourceGroupName: string,
  queryPackName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetQueryPack({
      subscriptionId,
      resourceGroupName,
      queryPackName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  pack: ObservedQueryPack,
): QueryPack["Attributes"] => ({
  queryPackName: name,
  resourceGroup,
  queryPackId: pack.id ?? "",
  queryPackGuid: pack.properties.queryPackId ?? "",
  location: pack.location,
  tags: userTags(pack.tags),
});

export const QueryPackProvider = () =>
  Provider.succeed(QueryPack, {
    stables: ["queryPackName", "resourceGroup", "queryPackId", "queryPackGuid"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* operationalinsights
        .ListQueryPacks({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListQueryPacks", page)));
      return (page.value ?? []).flatMap((pack) => {
        const group = resourceGroupOf(pack.id);
        return hasAnyAlchemyTag(pack.tags) &&
          group !== undefined &&
          pack.name !== undefined
          ? [toAttrs(group, pack.name, pack)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameText(news.name, output.queryPackName)) ||
        (news.location !== undefined &&
          !sameText(
            news.location.replaceAll(" ", ""),
            output.location.replaceAll(" ", ""),
          ))
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
        output?.queryPackName ??
        olds?.name ??
        (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getQueryPack(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.queryPackName ??
        (yield* createLogAnalyticsName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        queryPackName: name,
      };

      // Observe.
      let observed = yield* getQueryPack(subscriptionId, resourceGroup, name);

      // Ensure.
      if (observed === undefined) {
        observed = yield* operationalinsights.QueryPacksCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {},
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags against the observed pack.
        observed = yield* operationalinsights.UpdateQueryPackTags({
          ...where,
          tags,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteQueryPack({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          queryPackName: output.queryPackName,
        }),
      );
      yield* waitUntilGone(
        `query pack ${output.queryPackName}`,
        getQueryPack(subscriptionId, output.resourceGroup, output.queryPackName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
