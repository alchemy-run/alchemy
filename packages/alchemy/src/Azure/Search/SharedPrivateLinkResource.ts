import * as search from "@distilled.cloud/azure/search";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, waitForProvisioned } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createSearchName,
  deleteSharedPrivateLink,
  getSharedPrivateLink,
  SEARCH_NAMESPACE,
  searchServiceOwnedByStage,
  whileSharedPrivateLinkBusy,
} from "./internal.ts";

export interface SharedPrivateLinkResourceProps {
  /** Resource group of the search service. Changing it replaces the link. */
  resourceGroup: string;
  /** Search service that owns the link. Changing it replaces the link. */
  searchService: string;
  /**
   * Name of the shared private link. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * link.
   */
  name?: string;
  /**
   * ARM resource ID of the target resource (e.g. a storage account, key
   * vault, or SQL server). Changing it replaces the link.
   */
  privateLinkResourceId: string;
  /**
   * Private link sub-resource of the target, e.g. `blob`, `table`,
   * `vault`, or `sqlServer`. Changing it replaces the link.
   */
  groupId: string;
  /**
   * Message shown to the owner of the target resource when approving the
   * connection.
   */
  requestMessage?: string;
  /**
   * ARM location of the target. Only needed for resources whose DNS is
   * regional, such as Azure Kubernetes Service. Changing it replaces the
   * link.
   */
  resourceRegion?: string;
}

export interface SharedPrivateLinkResource extends Resource<
  "Azure.Search.SharedPrivateLinkResource",
  SharedPrivateLinkResourceProps,
  {
    /** Name of the shared private link. */
    sharedPrivateLinkResourceName: string;
    /** ARM resource ID of the shared private link. */
    sharedPrivateLinkResourceId: string;
    /** Search service that owns the link. */
    searchService: string;
    /** Resource group of the search service. */
    resourceGroup: string;
    /** ARM resource ID of the target resource. */
    privateLinkResourceId: string;
    /** Private link sub-resource of the target. */
    groupId: string;
    /** Approval message sent to the target owner. */
    requestMessage: string | undefined;
    /** ARM location of the target, when set. */
    resourceRegion: string | undefined;
    /**
     * Connection status: `Pending` until the target owner approves it,
     * then `Approved`, `Rejected`, or `Disconnected`.
     */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A shared private link from an Azure AI Search service to another Azure
 * resource, so indexers and skillsets reach data sources (Blob Storage,
 * Cosmos DB, SQL, Key Vault, ...) over a managed private endpoint. Azure
 * creates the connection as `Pending`; the owner of the target resource
 * must approve it before traffic flows. Needs a `basic` or higher search
 * service.
 *
 * @see https://learn.microsoft.com/azure/search/search-indexer-howto-access-private
 *
 * ### Connecting to Storage
 * **Example:** Private link to a storage account's blob endpoint
 * ```typescript
 * const search = yield* Azure.Search.SearchService("search", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const account = yield* Azure.Storage.StorageAccount("data", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const link = yield* Azure.Search.SharedPrivateLinkResource("blob-link", {
 *   resourceGroup: group.resourceGroupName,
 *   searchService: search.searchServiceName,
 *   privateLinkResourceId: account.storageAccountId,
 *   groupId: "blob",
 *   requestMessage: "Search indexer access",
 * });
 * ```
 *
 * @resource
 */
export const SharedPrivateLinkResource = Resource<SharedPrivateLinkResource>(
  "Azure.Search.SharedPrivateLinkResource",
);

const getLink = getSharedPrivateLink;

const toAttrs = (
  resourceGroup: string,
  searchService: string,
  name: string,
  link: search.GetSharedPrivateLinkResourceResponse,
): SharedPrivateLinkResource["Attributes"] => ({
  sharedPrivateLinkResourceName: name,
  sharedPrivateLinkResourceId: link.id ?? "",
  searchService,
  resourceGroup,
  privateLinkResourceId: link.properties?.privateLinkResourceId ?? "",
  groupId: link.properties?.groupId ?? "",
  requestMessage: link.properties?.requestMessage,
  resourceRegion: link.properties?.resourceRegion,
  status: link.properties?.status,
});

const lower = (value: string | undefined) => value?.toLowerCase();

/** `Incomplete` is a terminal provisioning failure for shared private links. */
const linkState = (link: search.GetSharedPrivateLinkResourceResponse) => {
  const state = link.properties?.provisioningState;
  return state === "Incomplete" ? "Failed" : state;
};

const WAIT = { interval: "10 seconds", times: 60 } as const;

export const SharedPrivateLinkResourceProvider = () =>
  Provider.succeed(SharedPrivateLinkResource, {
    stables: [
      "sharedPrivateLinkResourceName",
      "sharedPrivateLinkResourceId",
      "searchService",
      "resourceGroup",
      "privateLinkResourceId",
      "groupId",
    ],

    // Links live inside a search service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.searchService) !== lower(output.searchService) ||
        (news.name !== undefined &&
          news.name !== output.sharedPrivateLinkResourceName) ||
        lower(news.privateLinkResourceId) !==
          lower(output.privateLinkResourceId) ||
        lower(news.groupId) !== lower(output.groupId) ||
        lower(news.resourceRegion)?.replace(/\s/g, "") !==
          lower(output.resourceRegion)?.replace(/\s/g, "")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const searchService = output?.searchService ?? olds?.searchService;
      if (resourceGroup === undefined || searchService === undefined) {
        return undefined;
      }
      const name =
        output?.sharedPrivateLinkResourceName ??
        olds?.name ??
        (yield* createSearchName(id));
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        searchService,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, searchService, name, observed);
      return (yield* searchServiceOwnedByStage(
        subscriptionId,
        resourceGroup,
        searchService,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SEARCH_NAMESPACE);
      const { resourceGroup, searchService } = news;
      const name =
        news.name ??
        output?.sharedPrivateLinkResourceName ??
        (yield* createSearchName(id));
      const get = getLink(subscriptionId, resourceGroup, searchService, name);
      const label = `shared private link ${name}`;

      const converge = Effect.gen(function* () {
        // Observe.
        const observed = yield* get;

        // Ensure + sync: the PUT is a full upsert of the link's properties,
        // so send it when the link is missing, failed, or its message
        // drifted.
        if (
          observed === undefined ||
          linkState(observed) === "Failed" ||
          (news.requestMessage !== undefined &&
            observed.properties?.requestMessage !== news.requestMessage)
        ) {
          yield* search
            .SharedPrivateLinkResourcesCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              searchServiceName: searchService,
              sharedPrivateLinkResourceName: name,
              properties: {
                privateLinkResourceId: news.privateLinkResourceId,
                groupId: news.groupId,
                requestMessage: news.requestMessage,
                resourceRegion: news.resourceRegion,
              },
            })
            .pipe(Effect.retry(whileSharedPrivateLinkBusy));
        }
        // The PUT returns 202 and the GET keeps reporting the previous
        // `Succeeded` state until the update starts, so also wait for the
        // desired message to show up.
        return yield* waitForProvisioned(
          label,
          get,
          (link) =>
            linkState(link) === "Succeeded" &&
            news.requestMessage !== undefined &&
            link.properties?.requestMessage !== news.requestMessage
              ? "Updating"
              : linkState(link),
          WAIT,
        );
      });

      // A link created right after its search service can report `Failed`
      // while the service finishes setting up; re-sending the PUT recovers.
      const fresh = yield* converge.pipe(
        Effect.retry({
          while: (e) => e._tag === "Azure.ProvisioningFailed",
          schedule: Schedule.spaced("20 seconds"),
          times: 3,
        }),
      );
      return toAttrs(resourceGroup, searchService, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* deleteSharedPrivateLink(
        subscriptionId,
        output.resourceGroup,
        output.searchService,
        output.sharedPrivateLinkResourceName,
      );
    }),
  });
