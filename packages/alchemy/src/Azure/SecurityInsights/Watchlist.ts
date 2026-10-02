import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  compact,
  hasOwnMarker,
  isWorkspaceOwnedByStack,
  ownershipMarker,
  SENTINEL_NAMESPACE,
  sameText,
  subsetEqual,
  withMarker,
} from "./Common.ts";

export interface WatchlistProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the watchlist. */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the watchlist is created after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Watchlist alias, used in KQL as `_GetWatchlist('<alias>')`. If omitted, a
   * unique alias is generated from the app, stage, and logical ID. Changing
   * it replaces the watchlist.
   */
  watchlistAlias?: string;
  /** Display name of the watchlist. */
  displayName: string;
  /**
   * Provider of the watchlist (free text).
   * @default "Alchemy"
   */
  provider?: string;
  /**
   * Column used as the search key of the watchlist items. Changing it
   * replaces the watchlist.
   */
  itemsSearchKey: string;
  /**
   * Source file name of the watchlist (e.g. `servers.csv`). Changing it
   * replaces the watchlist.
   */
  source?: string;
  /**
   * Source type: `Local` (inline `rawContent`) or `AzureStorage`. Changing
   * it replaces the watchlist.
   */
  sourceType?: "Local" | "AzureStorage" | (string & {});
  /** Description of the watchlist. An Alchemy ownership marker is appended. */
  description?: string;
  /** Labels of the watchlist. */
  labels?: string[];
  /** Default time-to-live of watchlist items (ISO-8601 duration, e.g. `P1000Y`). */
  defaultDuration?: string;
  /**
   * CSV content of the watchlist (header row + data rows). Required for
   * `Local` watchlists. Changing it replaces the watchlist; manage individual
   * rows afterwards with `WatchlistItem`.
   */
  rawContent?: string;
  /**
   * Content type of `rawContent`.
   * @default "text/csv" when `rawContent` is set
   */
  contentType?: string;
  /**
   * Number of lines at the top of `rawContent` to skip before the header.
   * Changing it replaces the watchlist.
   * @default 0
   */
  numberOfLinesToSkip?: number;
}

export interface Watchlist extends Resource<
  "Azure.SecurityInsights.Watchlist",
  WatchlistProps,
  {
    /** Watchlist alias (the ARM resource name). */
    watchlistAlias: string;
    /** ARM resource ID of the watchlist. */
    watchlistResourceId: string;
    /** Service-assigned ID of the watchlist (GUID). */
    watchlistId: string | undefined;
    /** Sentinel workspace of the watchlist. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Display name of the watchlist. */
    displayName: string;
    /** Search key column. */
    itemsSearchKey: string;
    /** Provisioning state of the content upload (`Succeeded` once ingested). */
    provisioningState: string | undefined;
    /** ETag of the watchlist. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Sentinel watchlist: a named lookup table (e.g. VIP users,
 * approved servers) that analytics rules and hunting queries join against
 * with `_GetWatchlist('<alias>')`.
 *
 * @see https://learn.microsoft.com/azure/sentinel/watchlists
 *
 * ### Creating Watchlists
 * **Example:** Watchlist from inline CSV
 * ```typescript
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 * });
 * const servers = yield* Azure.SecurityInsights.Watchlist("servers", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "Approved servers",
 *   itemsSearchKey: "Hostname",
 *   source: "servers.csv",
 *   rawContent: "Hostname,Owner\nweb-01,platform\nweb-02,platform\n",
 * });
 * ```
 *
 * **Example:** Labelled watchlist with a default item lifetime
 * ```typescript
 * const vips = yield* Azure.SecurityInsights.Watchlist("vips", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "VIP users",
 *   itemsSearchKey: "UserPrincipalName",
 *   source: "vips.csv",
 *   rawContent: "UserPrincipalName,Tier\nceo@contoso.com,1\n",
 *   labels: ["identity"],
 *   defaultDuration: "P365D",
 * });
 * ```
 *
 * @resource
 */
export const Watchlist = Resource<Watchlist>("Azure.SecurityInsights.Watchlist");

const createAlias = (id: string) =>
  createPhysicalName({ id, maxLength: 64, delimiter: "_" }).pipe(
    Effect.map((name) => name.replace(/[^a-zA-Z0-9_-]/g, "_")),
  );

const getWatchlist = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  watchlistAlias: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetWatchlist({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      watchlistAlias,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  alias: string,
  watchlist: securityinsights.GetWatchlistResponse,
): Watchlist["Attributes"] => ({
  watchlistAlias: alias,
  watchlistResourceId: watchlist.id ?? "",
  watchlistId: watchlist.properties?.watchlistId,
  workspace,
  resourceGroup,
  displayName: watchlist.properties?.displayName ?? "",
  itemsSearchKey: watchlist.properties?.itemsSearchKey ?? "",
  provisioningState: watchlist.properties?.provisioningState,
  etag: watchlist.etag,
});

export const WatchlistProvider = () =>
  Provider.succeed(Watchlist, {
    stables: [
      "watchlistAlias",
      "watchlistResourceId",
      "watchlistId",
      "workspace",
      "resourceGroup",
      "itemsSearchKey",
    ],

    // Watchlists live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.watchlistAlias !== undefined &&
          !sameText(news.watchlistAlias, output.watchlistAlias)) ||
        news.itemsSearchKey !== output.itemsSearchKey ||
        (olds !== undefined &&
          (news.source !== olds.source ||
            news.sourceType !== olds.sourceType ||
            news.rawContent !== olds.rawContent ||
            (news.numberOfLinesToSkip ?? 0) !==
              (olds.numberOfLinesToSkip ?? 0)))
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
      const alias =
        output?.watchlistAlias ??
        olds?.watchlistAlias ??
        (yield* createAlias(id));
      const observed = yield* getWatchlist(
        subscriptionId,
        resourceGroup,
        workspace,
        alias,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, alias, observed);
      const owned =
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        )) && (yield* hasOwnMarker(id, observed.properties?.description));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const alias =
        news.watchlistAlias ??
        output?.watchlistAlias ??
        (yield* createAlias(id));
      const marker = yield* ownershipMarker(id);

      const mutable = compact({
        displayName: news.displayName,
        provider: news.provider ?? "Alchemy",
        itemsSearchKey: news.itemsSearchKey,
        description: withMarker(news.description, marker),
        labels: news.labels,
        defaultDuration: news.defaultDuration,
      });

      const content = compact({
        source: news.source,
        sourceType: news.sourceType ?? "Local",
        rawContent: news.rawContent,
        contentType:
          news.contentType ??
          (news.rawContent !== undefined ? "text/csv" : undefined),
        numberOfLinesToSkip:
          news.rawContent !== undefined
            ? (news.numberOfLinesToSkip ?? 0)
            : undefined,
      });

      // Observe; the PUT is a synchronous upsert. A `Local` watchlist
      // requires its content on every PUT, so content is re-sent with
      // metadata updates (content changes replace the watchlist).
      let observed = yield* getWatchlist(
        subscriptionId,
        resourceGroup,
        workspace,
        alias,
      );
      if (
        observed === undefined ||
        !subsetEqual(
          mutable,
          observed.properties as unknown as Record<string, unknown>,
        )
      ) {
        observed = yield* securityinsights.WatchlistsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          watchlistAlias: alias,
          etag: observed?.etag,
          properties: {
            ...mutable,
            ...content,
          } as securityinsights.WatchlistPropertiesInput,
        });
      }

      // Block until the uploaded content is ingested (bounded).
      if (news.rawContent !== undefined) {
        const ingested = yield* getWatchlist(
          subscriptionId,
          resourceGroup,
          workspace,
          alias,
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (w) => {
              const state = w?.properties?.provisioningState;
              return state === undefined || state === "Succeeded" || state === "Failed";
            },
            times: 20,
          }),
        );
        if (ingested !== undefined) observed = ingested;
      }
      return toAttrs(resourceGroup, workspace, alias, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteWatchlist({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          watchlistAlias: output.watchlistAlias,
        }),
      );
      yield* waitUntilGone(
        `watchlist ${output.watchlistAlias}`,
        getWatchlist(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.watchlistAlias,
        ),
      );
    }),
  });
