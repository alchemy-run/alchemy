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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  cacheOwnedByStage,
  createAlphanumericName,
  lower,
  whileCacheBusy,
} from "./Common.ts";

export interface AccessPolicyProps {
  /** Resource group of the cache. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the `Azure.Redis.Cache`. Changing it replaces the policy. */
  cache: string;
  /**
   * Policy name. If omitted, a unique alphanumeric name is generated from
   * the app, stage, and logical ID. The built-in names `Data Owner`,
   * `Data Contributor`, and `Data Reader` are reserved. Changing it
   * replaces the policy.
   */
  name?: string;
  /**
   * Redis ACL rules granted by the policy, e.g. `+@read +@connection ~*`
   * (commands, command categories, and key patterns).
   */
  permissions: string;
}

export interface AccessPolicy extends Resource<
  "Azure.Redis.AccessPolicy",
  AccessPolicyProps,
  {
    /** Name of the policy; reference it from access policy assignments. */
    accessPolicyName: string;
    /** ARM resource ID of the policy. */
    accessPolicyId: string;
    /** Name of the cache. */
    cache: string;
    /** Resource group of the cache. */
    resourceGroup: string;
    /** Redis ACL rules granted by the policy. */
    permissions: string;
    /** `Custom` for policies created here. */
    type: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom data access policy on an `Azure.Redis.Cache`: a named set of
 * Redis ACL rules that Microsoft Entra principals can be assigned to.
 *
 * Policies have no tags; they belong to the stage that owns their cache.
 *
 * @see https://learn.microsoft.com/azure/azure-cache-for-redis/cache-configure-role-based-access-control
 *
 * ### Defining Policies
 * **Example:** Read-only access to every key
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   redisConfiguration: { aadEnabled: true },
 * });
 * const reader = yield* Azure.Redis.AccessPolicy("reader", {
 *   resourceGroup: group.resourceGroupName,
 *   cache: cache.cacheName,
 *   permissions: "+@read +@connection ~*",
 * });
 * ```
 *
 * **Example:** Scope writes to a key prefix
 * ```typescript
 * yield* Azure.Redis.AccessPolicy("sessions", {
 *   resourceGroup: group.resourceGroupName,
 *   cache: cache.cacheName,
 *   name: "sessionswriter",
 *   permissions: "+@read +@write +@connection ~session:*",
 * });
 * ```
 *
 * @resource
 */
export const AccessPolicy = Resource<AccessPolicy>("Azure.Redis.AccessPolicy");

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  cacheName: string,
  accessPolicyName: string,
) =>
  orUndefinedIfNotFound(
    redis.GetAccessPolicy({
      subscriptionId,
      resourceGroupName,
      cacheName,
      accessPolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cache: string,
  name: string,
  policy: redis.GetAccessPolicyResponse,
): AccessPolicy["Attributes"] => ({
  accessPolicyName: name,
  accessPolicyId: policy.id ?? "",
  cache,
  resourceGroup,
  permissions: policy.properties?.permissions ?? "",
  type: policy.properties?.type ?? undefined,
});

export const AccessPolicyProvider = () =>
  Provider.succeed(AccessPolicy, {
    stables: ["accessPolicyName", "accessPolicyId", "cache", "resourceGroup"],

    // Policies live inside a cache; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cache) !== lower(output.cache) ||
        (news.name !== undefined && news.name !== output.accessPolicyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cache = output?.cache ?? olds?.cache;
      if (resourceGroup === undefined || cache === undefined) return undefined;
      const name =
        output?.accessPolicyName ??
        olds?.name ??
        (yield* createAlphanumericName(id, 60));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        cache,
        name,
      );
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
        news.name ??
        output?.accessPolicyName ??
        (yield* createAlphanumericName(id, 60));
      const get = getPolicy(subscriptionId, resourceGroup, cache, name);
      const label = `redis access policy ${name}`;
      const budget = { interval: "10 seconds", times: 60 } as const;
      const settle = waitForProvisioned(
        label,
        get,
        (policy) => policy.properties?.provisioningState,
        budget,
      );

      // Observe; let an in-flight update settle first.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* settle;

      // Ensure + sync: PUT is an upsert; send it only when the rules differ.
      if (
        observed === undefined ||
        observed.properties?.permissions !== news.permissions
      ) {
        yield* redis
          .AccessPolicyCreateUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            cacheName: cache,
            accessPolicyName: name,
            properties: { permissions: news.permissions },
          })
          .pipe(Effect.retry(whileCacheBusy));
        observed = yield* settle;
      }
      return toAttrs(resourceGroup, cache, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redis
          .DeleteAccessPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            cacheName: output.cache,
            accessPolicyName: output.accessPolicyName,
          })
          .pipe(Effect.retry(whileCacheBusy)),
      );
      yield* waitUntilGone(
        `redis access policy ${output.accessPolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.cache,
          output.accessPolicyName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Redis.Cache", "Azure.Resources.ResourceGroup"],
    },
  });
