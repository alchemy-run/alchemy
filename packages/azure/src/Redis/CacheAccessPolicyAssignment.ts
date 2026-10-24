import * as redis from "@distilled.cloud/azure/redis";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { cacheOwnedByStage, createAlphanumericName, lower, whileCacheBusy } from "./Common.ts";

export interface CacheAccessPolicyAssignmentProps {
  /** Resource group of the cache. Changing it replaces the assignment. */
  resourceGroup: string;
  /** Name of the `Azure.Redis.Cache`. Changing it replaces the assignment. */
  cache: string;
  /**
   * Assignment name. If omitted, a unique alphanumeric name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * assignment.
   */
  name?: string;
  /**
   * Access policy granted to the principal: a built-in policy
   * (`Data Owner`, `Data Contributor`, `Data Reader`) or the
   * `accessPolicyName` of an `Azure.Redis.AccessPolicy`. Changing it
   * replaces the assignment.
   */
  accessPolicyName: string;
  /**
   * Object (principal) ID of the Microsoft Entra user, group, service
   * principal or managed identity, e.g. a managed identity's
   * `principalId`. Changing it replaces the assignment.
   */
  objectId: string;
  /**
   * Friendly name for the principal; it is also the Redis username for
   * token authentication. Changing it replaces the assignment.
   * @default the `objectId`
   */
  objectIdAlias?: string;
}

export interface CacheAccessPolicyAssignment extends Resource<
  "Azure.Redis.CacheAccessPolicyAssignment",
  CacheAccessPolicyAssignmentProps,
  {
    /** Name of the assignment. */
    accessPolicyAssignmentName: string;
    /** ARM resource ID of the assignment. */
    accessPolicyAssignmentId: string;
    /** Name of the cache. */
    cache: string;
    /** Resource group of the cache. */
    resourceGroup: string;
    /** Access policy granted. */
    accessPolicyName: string;
    /** Object ID of the principal granted access. */
    objectId: string;
    /** Friendly name of the principal; the Redis username for token authentication. */
    objectIdAlias: string;
  },
  never,
  Providers
> {}

/**
 * Assigns a data access policy on an `Azure.Redis.Cache` to a Microsoft
 * Entra principal (ARM type `Microsoft.Cache/redis/accessPolicyAssignments`).
 * Clients then authenticate with an Entra token instead of access keys.
 * The cache needs `redisConfiguration.aadEnabled: true`.
 *
 * Assignments have no tags; they belong to the stage that owns their
 * cache. For Azure Managed Redis clusters use
 * `Azure.Redis.AccessPolicyAssignment`.
 *
 * :::caution
 * Every property is immutable: changing `resourceGroup`, `cache`, `name`,
 * `accessPolicyName`, `objectId` or `objectIdAlias` deletes the assignment
 * and creates a new one, so the principal briefly loses access.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-cache-for-redis/cache-configure-role-based-access-control
 *
 * ### Granting Access
 * **Example:** Let a managed identity read the cache
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("app");
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   redisConfiguration: { aadEnabled: true },
 * });
 * yield* Azure.Redis.CacheAccessPolicyAssignment("app-access", {
 *   cache: cache.cacheName,
 *   accessPolicyName: "Data Reader",
 *   objectId: identity.principalId,
 * });
 * ```
 *
 * **Example:** Assign a custom access policy
 * ```typescript
 * const sessions = yield* Azure.Redis.AccessPolicy("sessions", {
 *   cache: cache.cacheName,
 *   permissions: "+@read +@write +@connection ~session:*",
 * });
 * yield* Azure.Redis.CacheAccessPolicyAssignment("sessions-access", {
 *   cache: cache.cacheName,
 *   accessPolicyName: sessions.accessPolicyName,
 *   objectId: identity.principalId,
 *   objectIdAlias: "sessions-app",
 * });
 * ```
 *
 * @resource
 */
export const CacheAccessPolicyAssignment = GroupedResource<CacheAccessPolicyAssignment>(
  "Azure.Redis.CacheAccessPolicyAssignment",
);

const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  cacheName: string,
  accessPolicyAssignmentName: string,
) =>
  orUndefinedIfNotFound(
    redis.GetAccessPolicyAssignment({
      subscriptionId,
      resourceGroupName,
      cacheName,
      accessPolicyAssignmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cache: string,
  name: string,
  assignment: redis.GetAccessPolicyAssignmentResponse,
): CacheAccessPolicyAssignment["Attributes"] => ({
  accessPolicyAssignmentName: name,
  accessPolicyAssignmentId: assignment.id ?? "",
  cache,
  resourceGroup,
  accessPolicyName: assignment.properties?.accessPolicyName ?? "",
  objectId: assignment.properties?.objectId ?? "",
  objectIdAlias: assignment.properties?.objectIdAlias ?? "",
});

const BUDGET = { interval: "10 seconds", times: 60 } as const;

export const CacheAccessPolicyAssignmentProvider = () =>
  Provider.succeed(CacheAccessPolicyAssignment, {
    stables: [
      "accessPolicyAssignmentName",
      "accessPolicyAssignmentId",
      "cache",
      "resourceGroup",
      "accessPolicyName",
      "objectId",
      "objectIdAlias",
    ],

    // Assignments live inside a cache; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cache) !== lower(output.cache) ||
        (news.name !== undefined && news.name !== output.accessPolicyAssignmentName) ||
        news.accessPolicyName !== output.accessPolicyName ||
        lower(news.objectId) !== lower(output.objectId) ||
        (news.objectIdAlias ?? news.objectId) !== output.objectIdAlias
      ) {
        // The alias is the Redis username and must stay unique per cache.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cache = output?.cache ?? olds?.cache;
      if (resourceGroup === undefined || cache === undefined) return undefined;
      const name =
        output?.accessPolicyAssignmentName ??
        olds?.name ??
        (yield* createAlphanumericName(id, 60));
      const observed = yield* getAssignment(subscriptionId, resourceGroup, cache, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cache, name, observed);
      return (yield* cacheOwnedByStage(subscriptionId, resourceGroup, cache))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const { resourceGroup, cache } = news;
      const name =
        news.name ?? output?.accessPolicyAssignmentName ?? (yield* createAlphanumericName(id, 60));
      const get = getAssignment(subscriptionId, resourceGroup, cache, name);
      const label = `redis cache access policy assignment ${name}`;
      const desired = {
        accessPolicyName: news.accessPolicyName,
        objectId: news.objectId,
        objectIdAlias: news.objectIdAlias ?? news.objectId,
      };
      const matches = (assignment: redis.GetAccessPolicyAssignmentResponse) =>
        assignment.properties?.accessPolicyName === desired.accessPolicyName &&
        lower(assignment.properties?.objectId) === lower(desired.objectId) &&
        assignment.properties?.objectIdAlias === desired.objectIdAlias;

      // Observe; let an in-flight change settle first.
      let observed = yield* get;
      if (observed !== undefined) {
        observed = yield* waitForProvisioned(
          label,
          get,
          (assignment) => assignment.properties?.provisioningState,
          BUDGET,
        );
      }

      // Ensure + sync: PUT is an upsert; send it only when the cloud differs
      // (an adopted assignment may carry other values).
      if (observed === undefined || !matches(observed)) {
        yield* redis
          .AccessPolicyAssignmentCreateUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            cacheName: cache,
            accessPolicyAssignmentName: name,
            properties: desired,
          })
          .pipe(Effect.retry(whileCacheBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          (assignment) =>
            matches(assignment) ? assignment.properties?.provisioningState : "Updating",
          BUDGET,
        );
      }
      return toAttrs(resourceGroup, cache, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redis
          .DeleteAccessPolicyAssignment({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            cacheName: output.cache,
            accessPolicyAssignmentName: output.accessPolicyAssignmentName,
          })
          .pipe(Effect.retry(whileCacheBusy)),
      );
      yield* waitUntilGone(
        `redis cache access policy assignment ${output.accessPolicyAssignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.cache,
          output.accessPolicyAssignmentName,
        ),
        BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Redis.AccessPolicy",
        "Azure.Redis.Cache",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
