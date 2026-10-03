import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type ContextCacheAccountKind = "Regional" | "DataZone" | "Global";

export interface ContextCacheProps {
  /** Resource group of the context cache. Changing it replaces the cache. */
  resourceGroup: string;
  /**
   * Context cache name: 3-24 lowercase letters, digits, and hyphens,
   * starting and ending with a letter or digit. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the cache.
   */
  name?: string;
  /**
   * Azure region. Changing it replaces the cache.
   * @default the provider's default location
   */
  location?: string;
  /**
   * Deployment scope of the cache, matching the AI model deployment it
   * serves. Changing it replaces the cache.
   * @default "Regional"
   */
  accountKind?: ContextCacheAccountKind;
  /** Description of the cache. */
  description?: string;
  /**
   * Give the cache a system-assigned managed identity (needed for
   * customer-managed key encryption).
   * @default false
   */
  systemAssignedIdentity?: boolean;
  /** Resource tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface ContextCache extends Resource<
  "Azure.Storage.ContextCache",
  ContextCacheProps,
  {
    /** Name of the context cache. */
    contextCacheName: string;
    /** Resource group of the context cache. */
    resourceGroup: string;
    /** ARM resource ID of the context cache. */
    contextCacheId: string;
    /** Azure region of the context cache. */
    location: string;
    /** Deployment scope of the cache. */
    accountKind: string;
    /** Description of the cache. */
    description: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Storage context cache (`Microsoft.Storage/contextCaches`): managed
 * storage for AI model context (prompt) caches. Holds
 * {@link ContextCacheContainer}s, one per model.
 *
 * Context caches are a preview feature that needs subscription enrollment.
 *
 * ### Creating a Context Cache
 * **Example:** Regional context cache
 * ```typescript
 * const cache = yield* Azure.Storage.ContextCache("prompts", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "Prompt cache for the chat service",
 * });
 * ```
 *
 * **Example:** Global context cache with a managed identity
 * ```typescript
 * const cache = yield* Azure.Storage.ContextCache("prompts", {
 *   resourceGroup: group.resourceGroupName,
 *   accountKind: "Global",
 *   systemAssignedIdentity: true,
 * });
 * ```
 *
 * @resource
 */
export const ContextCache = Resource<ContextCache>(
  "Azure.Storage.ContextCache",
);

const createContextCacheName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const getCache = (
  subscriptionId: string,
  resourceGroupName: string,
  contextCacheName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetContextCach({
      subscriptionId,
      resourceGroupName,
      contextCacheName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: storage.GetContextCachResponse,
): ContextCache["Attributes"] => ({
  contextCacheName: name,
  resourceGroup,
  contextCacheId: observed.id ?? "",
  location: observed.location,
  accountKind: observed.properties.accountKind,
  description: observed.properties.description,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const sameLocation = (a: string, b: string) =>
  a.toLowerCase().replace(/\s/g, "") === b.toLowerCase().replace(/\s/g, "");

export const ContextCacheProvider = () =>
  Provider.succeed(ContextCache, {
    stables: ["contextCacheName", "resourceGroup", "contextCacheId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* storage
        .ListContextCachBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListContextCachBySubscription", page),
          ),
        );
      return page.value.flatMap((cache) => {
        const group = resourceGroupOf(cache.id);
        return hasAnyAlchemyTag(cache.tags) &&
          group !== undefined &&
          cache.name !== undefined
          ? [toAttrs(group, cache.name, cache)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined && news.name !== output.contextCacheName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        (news.accountKind ?? "Regional") !== output.accountKind
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
        output?.contextCacheName ??
        olds?.name ??
        (yield* createContextCacheName(id));
      const observed = yield* getCache(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return isOwned(id, observed.tags) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup } = news;
      const name =
        news.name ??
        output?.contextCacheName ??
        (yield* createContextCacheName(id));
      const tags = yield* desiredTags(id, news.tags);
      const identity = {
        type: news.systemAssignedIdentity ? "SystemAssigned" : "None",
      };
      const get = getCache(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* storage.ContextCachesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          contextCacheName: name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          identity,
          properties: {
            accountKind: news.accountKind ?? "Regional",
            description: news.description,
          },
        });
      } else {
        // Sync description, identity, and tags against the observed cache.
        const identityChanged =
          (observed.identity?.type ?? "None") !== identity.type;
        if (
          (news.description !== undefined &&
            observed.properties.description !== news.description) ||
          identityChanged ||
          tagsDiffer(observed.tags, tags)
        ) {
          yield* storage.UpdateContextCach({
            subscriptionId,
            resourceGroupName: resourceGroup,
            contextCacheName: name,
            tags,
            identity: identityChanged ? identity : undefined,
            properties:
              news.description !== undefined
                ? { description: news.description }
                : undefined,
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `context cache ${name}`,
        get,
        (value) => value.properties.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteContextCach({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          contextCacheName: output.contextCacheName,
        }),
      );
      yield* waitUntilGone(
        `context cache ${output.contextCacheName}`,
        getCache(subscriptionId, output.resourceGroup, output.contextCacheName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
