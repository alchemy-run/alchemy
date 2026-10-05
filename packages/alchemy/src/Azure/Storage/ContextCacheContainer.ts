import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ContextCacheContainerProps {
  /** Resource group of the context cache. Changing it replaces the container. */
  resourceGroup: string;
  /** Context cache that holds the container. Changing it replaces the container. */
  contextCache: string;
  /**
   * Container name: 3-61 lowercase letters, digits, and single hyphens. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the container.
   */
  name?: string;
  /**
   * AI model whose context the container caches, e.g. `gpt-4o`. Changing it
   * replaces the container.
   */
  modelName: string;
  /**
   * AI provider of the model. Changing it replaces the container.
   * @default "OpenAI"
   */
  provider?: "OpenAI";
  /** Description of the container. */
  description?: string;
  /**
   * Days (1-30) a cached blob is kept after its last access.
   * @default 1
   */
  timeToLive?: number;
}

export interface ContextCacheContainer extends Resource<
  "Azure.Storage.ContextCacheContainer",
  ContextCacheContainerProps,
  {
    /** Name of the container. */
    contextCacheContainerName: string;
    /** Context cache that holds the container. */
    contextCache: string;
    /** Resource group of the context cache. */
    resourceGroup: string;
    /** ARM resource ID of the container. */
    contextCacheContainerId: string;
    /** AI model whose context the container caches. */
    modelName: string;
    /** AI provider of the model. */
    provider: string;
    /** Description of the container. */
    description: string | undefined;
    /** Days a cached blob is kept after its last access. */
    timeToLive: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A container in a Storage {@link ContextCache} that caches the context of
 * one AI model. Blobs not accessed within `timeToLive` days are deleted
 * automatically.
 *
 * Context caches are a preview feature that needs subscription enrollment.
 *
 * ### Caching a Model's Context
 * **Example:** Container for a model
 * ```typescript
 * const cache = yield* Azure.Storage.ContextCache("prompts", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.ContextCacheContainer("gpt4o", {
 *   resourceGroup: group.resourceGroupName,
 *   contextCache: cache.contextCacheName,
 *   modelName: "gpt-4o",
 *   timeToLive: 7,
 * });
 * ```
 *
 * @resource
 */
export const ContextCacheContainer = Resource<ContextCacheContainer>(
  "Azure.Storage.ContextCacheContainer",
);

/** 3-61 lowercase letters, digits, and single hyphens. */
const createContainerName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 61,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const getContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  contextCacheName: string,
  contextCacheContainerName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetContextCacheContainer({
      subscriptionId,
      resourceGroupName,
      contextCacheName,
      contextCacheContainerName,
    }),
  );

/** Containers carry no tags; they inherit ownership from their cache. */
const isCacheOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  contextCacheName: string,
) {
  const cache = yield* orUndefinedIfNotFound(
    storage.GetContextCach({
      subscriptionId,
      resourceGroupName,
      contextCacheName,
    }),
  );
  if (cache === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(cache.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

const toAttrs = (
  resourceGroup: string,
  contextCache: string,
  name: string,
  observed: storage.GetContextCacheContainerResponse,
): ContextCacheContainer["Attributes"] => ({
  contextCacheContainerName: name,
  contextCache,
  resourceGroup,
  contextCacheContainerId: observed.id ?? "",
  modelName: observed.properties.modelName,
  provider: observed.properties.provider,
  description: observed.properties.description,
  timeToLive: observed.properties.timeToLive,
});

export const ContextCacheContainerProvider = () =>
  Provider.succeed(ContextCacheContainer, {
    stables: [
      "contextCacheContainerName",
      "contextCache",
      "resourceGroup",
      "contextCacheContainerId",
    ],

    // Containers disappear with their context cache.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.contextCache !== output.contextCache ||
        (news.name !== undefined &&
          news.name !== output.contextCacheContainerName) ||
        news.modelName !== output.modelName ||
        (news.provider ?? "OpenAI") !== output.provider
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const contextCache = output?.contextCache ?? olds?.contextCache;
      if (resourceGroup === undefined || contextCache === undefined) {
        return undefined;
      }
      const name =
        output?.contextCacheContainerName ??
        olds?.name ??
        (yield* createContainerName(id));
      const observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        contextCache,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, contextCache, name, observed);
      return (yield* isCacheOwnedByStack(
        subscriptionId,
        resourceGroup,
        contextCache,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, contextCache } = news;
      const name =
        news.name ??
        output?.contextCacheContainerName ??
        (yield* createContainerName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        contextCacheName: contextCache,
        contextCacheContainerName: name,
      };
      const get = getContainer(
        subscriptionId,
        resourceGroup,
        contextCache,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* storage.ContextCacheContainersCreateOrUpdate({
          ...where,
          properties: {
            modelName: news.modelName,
            provider: news.provider ?? "OpenAI",
            description: news.description,
            timeToLive: news.timeToLive,
          },
        });
      } else if (
        (news.description !== undefined &&
          observed.properties.description !== news.description) ||
        (news.timeToLive !== undefined &&
          observed.properties.timeToLive !== news.timeToLive)
      ) {
        // Sync the mutable settings against the observed container.
        yield* storage.UpdateContextCacheContainer({
          ...where,
          properties: {
            description: news.description,
            timeToLive: news.timeToLive,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `context cache container ${name}`,
        get,
        (value) => value.properties.provisioningState,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, contextCache, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteContextCacheContainer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          contextCacheName: output.contextCache,
          contextCacheContainerName: output.contextCacheContainerName,
        }),
      );
      yield* waitUntilGone(
        `context cache container ${output.contextCacheContainerName}`,
        getContainer(
          subscriptionId,
          output.resourceGroup,
          output.contextCache,
          output.contextCacheContainerName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.ContextCache",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
