import * as redis from "@distilled.cloud/azure/redis";
import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
} from "../Arm.ts";

/**
 * Cluster name: letters, digits, and single hyphens. Azure caps the name
 * plus the location's display name (e.g. `East US`) at 62 characters, so
 * generated names stop at 40.
 */
export const createClusterName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 40,
    lowercase: true,
    delimiter: "-",
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
});

export const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    redisenterprise.GetRedisEnterprise({
      subscriptionId,
      resourceGroupName,
      clusterName,
    }),
  );

export const getDatabase = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    redisenterprise.GetDatabase({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
    }),
  );

/**
 * Databases and access policy assignments have no tags; they belong to the
 * stage that owns their cluster.
 */
export const clusterOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) {
  const observed = yield* getCluster(
    subscriptionId,
    resourceGroupName,
    clusterName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

const FAILED_RESOURCE_STATES = new Set([
  "CreateFailed",
  "UpdateFailed",
  "DeleteFailed",
  "EnableFailed",
  "DisableFailed",
  "ScalingFailed",
]);

/**
 * Readiness of a cluster or database: ARM reports `provisioningState:
 * Succeeded` before the Redis data plane is `Running`, so both must settle.
 * Mapped onto the `waitForProvisioned` vocabulary.
 */
export const readiness = (value: {
  properties?: { provisioningState?: string; resourceState?: string };
}) => {
  const provisioning = value.properties?.provisioningState;
  if (provisioning !== undefined && provisioning !== "Succeeded") {
    return provisioning;
  }
  const resource = value.properties?.resourceState;
  if (resource === undefined || resource === "Running") return "Succeeded";
  if (FAILED_RESOURCE_STATES.has(resource)) return "Failed";
  return resource;
};

export const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * Azure Cache for Redis (`Microsoft.Cache/redis`) name: 1-63 letters,
 * digits, and single hyphens, starting and ending with a letter or digit.
 * It forms the globally unique host name `<name>.redis.cache.windows.net`.
 */
export const createCacheName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "-",
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
});

/**
 * Child names that only allow letters, digits, and underscores (firewall
 * rules) or that we keep alphanumeric (access policies).
 */
export const createAlphanumericName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

export const getCache = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    redis.GetRedis({ subscriptionId, resourceGroupName, name }),
  );

/**
 * Cache children have no tags; they belong to the stage that owns their
 * cache.
 */
export const cacheOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  cacheName: string,
) {
  const observed = yield* getCache(subscriptionId, resourceGroupName, cacheName);
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * A cache processes one update at a time (scaling, configuration, access
 * policy changes, linking); further writes to it or its children fail with
 * `Conflict` ("busy processing a previous update request"). Retry them,
 * bounded.
 */
export const whileCacheBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("15 seconds"),
  times: 40,
} as const;

/** Budget for a cache to settle after create, scale, or link (up to ~45 min). */
export const CACHE_BUDGET = { interval: "45 seconds", times: 60 } as const;

/** Wait until the cache accepts the next update. */
export const waitForCacheIdle = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  waitForProvisioned(
    `redis cache ${name}`,
    getCache(subscriptionId, resourceGroupName, name),
    (cache) => cache.properties.provisioningState,
    CACHE_BUDGET,
  );

/** Like `waitForCacheIdle`, but a missing cache counts as idle. */
export const waitForCacheIdleIfExists = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const cache = yield* getCache(subscriptionId, resourceGroupName, name);
    if (cache === undefined) return;
    yield* waitForCacheIdle(subscriptionId, resourceGroupName, name);
  });
