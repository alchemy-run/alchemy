import * as redis from "@distilled.cloud/azure/redis";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  CACHE_BUDGET,
  cacheOwnedByStage,
  lower,
  waitForCacheIdle,
  waitForCacheIdleIfExists,
  whileCacheBusy,
} from "./Common.ts";

export interface LinkedServerProps {
  /**
   * Resource group of the primary cache. Changing it replaces the link.
   */
  resourceGroup: string;
  /**
   * Name of the primary (geo-primary) Premium `Azure.Redis.Cache`.
   * Changing it replaces the link.
   */
  cache: string;
  /**
   * ARM resource ID of the secondary cache: same Premium size, another
   * region, empty, and not already linked. Changing it replaces the link.
   */
  linkedCacheId: string;
  /** Location of the secondary cache, e.g. `westus2`. Changing it replaces the link. */
  linkedCacheLocation: string;
  /**
   * Role of the linked cache. Changing it replaces the link.
   * @default "Secondary"
   */
  serverRole?: "Primary" | "Secondary";
  /**
   * Link name; Azure names links after the linked cache.
   * @default the name in `linkedCacheId`
   */
  name?: string;
}

export interface LinkedServer extends Resource<
  "Azure.Redis.LinkedServer",
  LinkedServerProps,
  {
    /** Name of the link. */
    linkedServerName: string;
    /** ARM resource ID of the link. */
    linkedServerId: string;
    /** Name of the primary cache. */
    cache: string;
    /** Resource group of the primary cache. */
    resourceGroup: string;
    /** ARM resource ID of the linked cache. */
    linkedCacheId: string;
    /** Location of the linked cache. */
    linkedCacheLocation: string;
    /** Role of the linked cache. */
    serverRole: string;
    /** DNS name that always points at the current geo-primary cache. */
    geoReplicatedPrimaryHostName: string | undefined;
    /** DNS name of the current geo-primary cache. */
    primaryHostName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Passive geo-replication between two Premium `Azure.Redis.Cache`
 * instances: the secondary cache becomes a read-only replica of the
 * primary. Linking takes several minutes; both caches must be the same
 * Premium size and the secondary must be empty.
 *
 * Links have no tags; they belong to the stage that owns the primary
 * cache.
 *
 * @see https://learn.microsoft.com/azure/azure-cache-for-redis/cache-how-to-geo-replication
 *
 * ### Geo-Replication
 * **Example:** Replicate an East US cache to West US 2
 * ```typescript
 * const primary = yield* Azure.Redis.Cache("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   sku: "Premium",
 *   capacity: 1,
 * });
 * const secondary = yield* Azure.Redis.Cache("secondary", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   sku: "Premium",
 *   capacity: 1,
 * });
 * const link = yield* Azure.Redis.LinkedServer("geo", {
 *   resourceGroup: group.resourceGroupName,
 *   cache: primary.cacheName,
 *   linkedCacheId: secondary.cacheId,
 *   linkedCacheLocation: secondary.location,
 * });
 * // connect clients to link.geoReplicatedPrimaryHostName
 * ```
 *
 * @resource
 */
export const LinkedServer = Resource<LinkedServer>("Azure.Redis.LinkedServer");

const nameOf = (armId: string) => armId.split("/").filter(Boolean).pop() ?? "";

const armLocation = (location: string) =>
  location.replace(/\s+/g, "").toLowerCase();

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  linkedServerName: string,
) =>
  orUndefinedIfNotFound(
    redis.GetLinkedServer({
      subscriptionId,
      resourceGroupName,
      name,
      linkedServerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cache: string,
  name: string,
  link: redis.GetLinkedServerResponse,
): LinkedServer["Attributes"] => ({
  linkedServerName: name,
  linkedServerId: link.id ?? "",
  cache,
  resourceGroup,
  linkedCacheId: link.properties?.linkedRedisCacheId ?? "",
  linkedCacheLocation: armLocation(
    link.properties?.linkedRedisCacheLocation ?? "",
  ),
  serverRole: link.properties?.serverRole ?? "",
  geoReplicatedPrimaryHostName:
    link.properties?.geoReplicatedPrimaryHostName ?? undefined,
  primaryHostName: link.properties?.primaryHostName ?? undefined,
});

/** Wait until the linked cache accepts updates again (after link/unlink). */
const waitForLinkedCacheIdle = (subscriptionId: string, linkedCacheId: string) => {
  const group = resourceGroupOf(linkedCacheId);
  return group === undefined
    ? Effect.void
    : waitForCacheIdleIfExists(subscriptionId, group, nameOf(linkedCacheId));
};

export const LinkedServerProvider = () =>
  Provider.succeed(LinkedServer, {
    stables: [
      "linkedServerName",
      "linkedServerId",
      "cache",
      "resourceGroup",
      "linkedCacheId",
      "linkedCacheLocation",
      "serverRole",
    ],

    // Links live inside a cache; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cache) !== lower(output.cache) ||
        lower(news.linkedCacheId) !== lower(output.linkedCacheId) ||
        armLocation(news.linkedCacheLocation) !==
          armLocation(output.linkedCacheLocation) ||
        (news.serverRole ?? "Secondary") !== output.serverRole ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.linkedServerName))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cache = output?.cache ?? olds?.cache;
      const linkedCacheId = output?.linkedCacheId ?? olds?.linkedCacheId;
      if (
        resourceGroup === undefined ||
        cache === undefined ||
        linkedCacheId === undefined
      ) {
        return undefined;
      }
      const name =
        output?.linkedServerName ?? olds?.name ?? nameOf(linkedCacheId);
      const observed = yield* getLink(subscriptionId, resourceGroup, cache, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cache, name, observed);
      return (yield* cacheOwnedByStage(subscriptionId, resourceGroup, cache))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const { resourceGroup, cache } = news;
      const name =
        news.name ?? output?.linkedServerName ?? nameOf(news.linkedCacheId);
      const get = getLink(subscriptionId, resourceGroup, cache, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Existence-only: every property is immutable (no update API).
      if (observed === undefined) {
        // Both caches must be idle before they can be linked.
        yield* waitForCacheIdle(subscriptionId, resourceGroup, cache);
        yield* waitForLinkedCacheIdle(subscriptionId, news.linkedCacheId);
        yield* redis
          .CreateLinkedServer({
            subscriptionId,
            resourceGroupName: resourceGroup,
            name: cache,
            linkedServerName: name,
            properties: {
              linkedRedisCacheId: news.linkedCacheId,
              linkedRedisCacheLocation: news.linkedCacheLocation,
              serverRole: news.serverRole ?? "Secondary",
            },
          })
          .pipe(Effect.retry(whileCacheBusy));
      }
      const fresh = yield* waitForProvisioned(
        `redis linked server ${name}`,
        get,
        (link) => link.properties?.provisioningState,
        CACHE_BUDGET,
      );
      yield* waitForCacheIdle(subscriptionId, resourceGroup, cache);
      return toAttrs(resourceGroup, cache, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redis
          .DeleteLinkedServer({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            name: output.cache,
            linkedServerName: output.linkedServerName,
          })
          .pipe(Effect.retry(whileCacheBusy)),
      );
      yield* waitUntilGone(
        `redis linked server ${output.linkedServerName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.cache,
          output.linkedServerName,
        ),
        CACHE_BUDGET,
      );
      // Unlinking leaves both caches busy; settle them so their own
      // deletes or updates are accepted.
      yield* waitForCacheIdleIfExists(
        subscriptionId,
        output.resourceGroup,
        output.cache,
      );
      yield* waitForLinkedCacheIdle(subscriptionId, output.linkedCacheId);
    }),

    nuke: {
      dependsOn: ["Azure.Redis.Cache", "Azure.Resources.ResourceGroup"],
    },
  });
