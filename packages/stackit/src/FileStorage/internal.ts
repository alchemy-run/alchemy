/**
 * Shared scaffolding for the STACKIT File Storage resources. Not exported from
 * the namespace barrel.
 */
import * as sfs from "@distilled.cloud/stackit/sfs";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { waitFor, waitUntilGone } from "../internal/wait.ts";

/** Where a File Storage object lives: every API path carries both. */
export interface FileStorageScope {
  projectId: string;
  region: string;
}

/** Resource pool create, update and delete budget (the SDK's 30-minute wait handlers). */
export const RESOURCE_POOL_TIMEOUT = "30 minutes";

/** Share create, update and delete budget (the SDK's 10-minute wait handlers). */
export const SHARE_TIMEOUT = "10 minutes";

/** How long a deleted object may keep showing in lists, or a policy its share count. */
export const SETTLE_TIMEOUT = "2 minutes";

/** No STACKIT source states a limit on File Storage names, so this is the platform's usual one. */
const MAX_NAME_LENGTH = 63;

/** A generated name for a pool, share, export policy or snapshot. */
export const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: MAX_NAME_LENGTH });

/** The `maxLength` of {@link generatedName}, for matching its shape in `list`. */
export const GENERATED_NAME_MAX_LENGTH = MAX_NAME_LENGTH;

/**
 * The API answered 200 without a field every later call needs. The spec makes every
 * response field optional, and nothing can proceed without the id.
 */
export class FileStorageResponseIncomplete extends Data.TaggedError(
  "Stackit.FileStorage.ResponseIncomplete",
)<{
  readonly resource: string;
  readonly field: string;
  readonly message: string;
}> {}

const incomplete = (resource: string, field: string) =>
  new FileStorageResponseIncomplete({
    resource,
    field,
    message: `The STACKIT File Storage API answered without the ${field} of ${resource}`,
  });

export type ObservedResourcePool = sfs.ResourcePool & { readonly id: string };
export type ObservedShare = sfs.Share & { readonly id: string };
export type ObservedPolicy = sfs.ShareExportPolicy & { readonly id: string };

const hasId = <A extends { readonly id?: string }>(item: A): item is A & { readonly id: string } =>
  item.id !== undefined;

/** The pool in a response, failing typed when the response has no pool id. */
export const requirePool = (response: {
  readonly resourcePool?: sfs.ResourcePool;
}): Effect.Effect<ObservedResourcePool, FileStorageResponseIncomplete> =>
  response.resourcePool !== undefined && hasId(response.resourcePool)
    ? Effect.succeed(response.resourcePool)
    : Effect.fail(incomplete("a resource pool", "id"));

/** The share in a response, failing typed when the response has no share id. */
export const requireShare = (response: {
  readonly share?: sfs.Share;
}): Effect.Effect<ObservedShare, FileStorageResponseIncomplete> =>
  response.share !== undefined && hasId(response.share)
    ? Effect.succeed(response.share)
    : Effect.fail(incomplete("a share", "id"));

/** The policy in a response, failing typed when the response has no policy id. */
export const requirePolicy = (response: {
  readonly shareExportPolicy?: sfs.ShareExportPolicy;
}): Effect.Effect<ObservedPolicy, FileStorageResponseIncomplete> =>
  response.shareExportPolicy !== undefined && hasId(response.shareExportPolicy)
    ? Effect.succeed(response.shareExportPolicy)
    : Effect.fail(incomplete("a share export policy", "id"));

/** `GetResourcePool`; `undefined` once the pool is gone. */
export const getPoolOrUndefined = (scope: FileStorageScope, resourcePoolId: string) =>
  sfs.getResourcePool({ ...scope, resourcePoolId }).pipe(
    Effect.flatMap(requirePool),
    Effect.catchTag(["NotFound", "Gone"], () => Effect.undefined),
  );

/** Every resource pool of a project in a region. The API doesn't paginate this list. */
export const listAllPools = (scope: FileStorageScope) =>
  sfs
    .listResourcePools(scope)
    .pipe(Effect.map((response) => (response.resourcePools ?? []).filter(hasId)));

/** The pool with this name, in any state. */
export const findPoolByName = (scope: FileStorageScope, name: string) =>
  listAllPools(scope).pipe(Effect.map((pools) => pools.find((pool) => pool.name === name)));

/** Wait until a pool is `created` and `applied` holds, for a change just sent. */
export const waitForPool = (
  scope: FileStorageScope,
  resourcePoolId: string,
  applied: (pool: ObservedResourcePool) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT File Storage resource pool ${resourcePoolId}`,
    read: sfs.getResourcePool({ ...scope, resourcePoolId }).pipe(Effect.flatMap(requirePool)),
    ready: (pool) => pool.state === "created" && applied(pool),
    failed: (pool) =>
      pool.state === "error"
        ? "error"
        : pool.state === "deleting"
          ? "it is being deleted"
          : undefined,
    state: (pool) => pool.state,
    timeout: RESOURCE_POOL_TIMEOUT,
    maxInterval: "15 seconds",
  });

/** Wait until a pool is gone. `failed` decides when `error` is final. */
export const waitForPoolGone = (
  scope: FileStorageScope,
  resourcePoolId: string,
  failed: (state: string | undefined) => boolean,
) =>
  waitUntilGone({
    resource: `STACKIT File Storage resource pool ${resourcePoolId}`,
    read: getPoolOrUndefined(scope, resourcePoolId),
    state: (pool) => pool.state,
    failed: (pool) => (failed(pool.state) ? pool.state : undefined),
    timeout: RESOURCE_POOL_TIMEOUT,
    maxInterval: "15 seconds",
  });

/** `GetShare`; `undefined` once the share is gone. */
export const getShareOrUndefined = (
  scope: FileStorageScope,
  resourcePoolId: string,
  shareId: string,
) =>
  sfs.getShare({ ...scope, resourcePoolId, shareId }).pipe(
    Effect.flatMap(requireShare),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Every share of a pool. The API doesn't paginate this list. */
export const listPoolShares = (scope: FileStorageScope, resourcePoolId: string) =>
  sfs
    .listShares({ ...scope, resourcePoolId })
    .pipe(Effect.map((response) => (response.shares ?? []).filter(hasId)));

/** `GetShareExportPolicy`; `undefined` once the policy is gone. */
export const getPolicyOrUndefined = (scope: FileStorageScope, policyId: string) =>
  sfs.getShareExportPolicy({ ...scope, policyId }).pipe(
    Effect.flatMap(requirePolicy),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Every share export policy of a project in a region. The API doesn't paginate this list. */
export const listAllPolicies = (scope: FileStorageScope) =>
  sfs
    .listShareExportPolicies(scope)
    .pipe(Effect.map((response) => (response.shareExportPolicies ?? []).filter(hasId)));

/** The snapshots of a pool, empty once the pool is gone. */
export const listPoolSnapshots = (scope: FileStorageScope, resourcePoolId: string) =>
  sfs.listResourcePoolSnapshots({ ...scope, resourcePoolId }).pipe(
    Effect.map((response) => response.resourcePoolSnapshots ?? []),
    Effect.catchTag("NotFound", () => Effect.succeed([] as sfs.ResourcePoolSnapshot[])),
  );

/**
 * The spec's 409 on a pool delete: the example names a pool that can't go yet. It
 * clears once the pool settles. Bounded to about two minutes.
 */
export const poolConflictRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;
