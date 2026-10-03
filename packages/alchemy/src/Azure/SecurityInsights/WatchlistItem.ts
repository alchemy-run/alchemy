import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  deterministicGuid,
  isWorkspaceOwnedByStack,
  SENTINEL_NAMESPACE,
  sameText,
  subsetEqual,
} from "./Common.ts";

export interface WatchlistItemProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the item. */
  resourceGroup: string;
  /** Sentinel workspace of the watchlist. Changing it replaces the item. */
  workspace: string;
  /** Alias of the parent watchlist (`Watchlist.watchlistAlias`). Changing it replaces the item. */
  watchlistAlias: string;
  /**
   * Item ID (a GUID). If omitted, a deterministic GUID is derived from the
   * app, stage, and logical ID. Changing it replaces the item.
   */
  watchlistItemId?: string;
  /**
   * Column values of the row, keyed by the watchlist's column names. Must
   * include the watchlist's `itemsSearchKey` column.
   */
  itemsKeyValue: Record<string, string>;
}

export interface WatchlistItem extends Resource<
  "Azure.SecurityInsights.WatchlistItem",
  WatchlistItemProps,
  {
    /** Item ID (GUID). */
    watchlistItemId: string;
    /** ARM resource ID of the item. */
    watchlistItemResourceId: string;
    /** Alias of the parent watchlist. */
    watchlistAlias: string;
    /** Sentinel workspace of the watchlist. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Column values of the row as stored. */
    itemsKeyValue: Record<string, unknown>;
    /** ETag of the item. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A row of a Microsoft Sentinel watchlist.
 *
 * @see https://learn.microsoft.com/azure/sentinel/watchlists-manage
 *
 * ### Managing Rows
 * **Example:** Add a VIP user to a watchlist
 * ```typescript
 * const vips = yield* Azure.SecurityInsights.Watchlist("vips", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "VIP users",
 *   itemsSearchKey: "UserPrincipalName",
 * });
 * yield* Azure.SecurityInsights.WatchlistItem("ceo", {
 *   resourceGroup: vips.resourceGroup,
 *   workspace: vips.workspace,
 *   watchlistAlias: vips.watchlistAlias,
 *   itemsKeyValue: { UserPrincipalName: "ceo@contoso.com", Tier: "1" },
 * });
 * ```
 *
 * @resource
 */
export const WatchlistItem = Resource<WatchlistItem>(
  "Azure.SecurityInsights.WatchlistItem",
);

const getItem = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  watchlistAlias: string,
  watchlistItemId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetWatchlistItem({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      watchlistAlias,
      watchlistItemId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  watchlistAlias: string,
  itemId: string,
  item: securityinsights.GetWatchlistItemResponse,
): WatchlistItem["Attributes"] => ({
  watchlistItemId: itemId,
  watchlistItemResourceId: item.id ?? "",
  watchlistAlias,
  workspace,
  resourceGroup,
  itemsKeyValue: (item.properties?.itemsKeyValue ?? {}) as Record<
    string,
    unknown
  >,
  etag: item.etag,
});

export const WatchlistItemProvider = () =>
  Provider.succeed(WatchlistItem, {
    stables: [
      "watchlistItemId",
      "watchlistItemResourceId",
      "watchlistAlias",
      "workspace",
      "resourceGroup",
    ],

    // Items vanish with their watchlist.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.watchlistAlias, output.watchlistAlias) ||
        (news.watchlistItemId !== undefined &&
          !sameText(news.watchlistItemId, output.watchlistItemId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      const alias = output?.watchlistAlias ?? olds?.watchlistAlias;
      if (
        resourceGroup === undefined ||
        workspace === undefined ||
        alias === undefined
      ) {
        return undefined;
      }
      const itemId =
        output?.watchlistItemId ??
        olds?.watchlistItemId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getItem(
        subscriptionId,
        resourceGroup,
        workspace,
        alias,
        itemId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, alias, itemId, observed);
      // Rows carry no free text: ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace, watchlistAlias } = news;
      const itemId =
        news.watchlistItemId ??
        output?.watchlistItemId ??
        (yield* deterministicGuid(id, instanceId));

      let observed = yield* getItem(
        subscriptionId,
        resourceGroup,
        workspace,
        watchlistAlias,
        itemId,
      );
      const observedValues = observed?.properties?.itemsKeyValue as
        | Record<string, unknown>
        | undefined;
      if (
        observed === undefined ||
        !subsetEqual(news.itemsKeyValue, observedValues)
      ) {
        observed = yield* securityinsights.WatchlistItemsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          watchlistAlias,
          watchlistItemId: itemId,
          etag: observed?.etag,
          properties: { itemsKeyValue: news.itemsKeyValue },
        });
      }
      return toAttrs(resourceGroup, workspace, watchlistAlias, itemId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteWatchlistItem({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          watchlistAlias: output.watchlistAlias,
          watchlistItemId: output.watchlistItemId,
        }),
      );
      yield* waitUntilGone(
        `watchlist item ${output.watchlistItemId}`,
        getItem(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.watchlistAlias,
          output.watchlistItemId,
        ),
      );
    }),
  });
