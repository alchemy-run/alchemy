import * as sfs from "@distilled.cloud/stackit/sfs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  findPoolByName,
  type FileStorageScope,
  generatedName,
  getPoolOrUndefined,
  listAllPools,
  listPoolShares,
  type ObservedResourcePool,
  poolConflictRetry,
  requirePool,
  SETTLE_TIMEOUT,
  waitForPool,
  waitForPoolGone,
} from "./internal.ts";

export interface ResourcePoolProps {
  /**
   * Name of the resource pool. STACKIT can't rename a pool, so changing it replaces
   * the pool, and **every share in the pool and all their data are lost**. Removing an
   * explicit name keeps the pool under the name it has.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Availability zone, e.g. `eu01-1`. Changing it replaces the pool, and **every share
   * in the pool and all their data are lost**.
   */
  availabilityZone: string;
  /**
   * Performance class, e.g. `Standard`; `listPerformanceClasses` in the API lists them.
   * Updates in place. STACKIT refuses a downgrade
   * until `performanceClassDowngradableAt`, and the deploy fails with
   * `Stackit.FileStorage.ResourcePoolChangeBlocked` until then.
   */
  performanceClass: string;
  /**
   * Size of the pool in GB, at least 500. Updates in place. STACKIT refuses a shrink
   * until `sizeReducibleAt`, and the deploy fails with
   * `Stackit.FileStorage.ResourcePoolChangeBlocked` until then.
   */
  sizeGigabytes: number;
  /**
   * CIDR ranges that can mount the pool read-only, e.g. `10.0.0.0/24`. A share's export
   * policy can only narrow this: a client outside it can't mount the share read-write
   * either. Updates in place.
   */
  ipAcl: string[];
  /**
   * Id of a snapshot policy, which takes snapshots on a schedule. STACKIT defines the
   * policies; `listSnapshotPolicies` in the API lists them. Updates in place. Removing
   * the prop removes the policy; a pool that never set it keeps what it has.
   */
  snapshotPolicyId?: string;
  /**
   * Whether mounting the pool shows its `.snapshot` directory. Updates in place; omit it
   * to leave the live setting alone.
   */
  snapshotsAreVisible?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`, `alchemy.instance`) are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the pool. Changing it replaces the pool, and **every share in the
   * pool and all their data are lost**.
   *
   * @default the profile's project
   */
  projectId?: string;
  /**
   * Region of the pool. Changing it replaces the pool, and **every share in the pool and
   * all their data are lost**.
   *
   * @default the profile's region
   */
  region?: string;
}

/** The performance a pool's class gives it. */
export interface ResourcePoolPerformanceClass {
  /** Name of the class. */
  name: string | undefined;
  /** Highest IOPS, shared by every share in the pool. */
  peakIops: number | undefined;
  /** Throughput, shared by every share in the pool. */
  throughput: number | undefined;
}

/** The snapshot policy a pool uses. */
export interface ResourcePoolSnapshotPolicyRef {
  /** Id of the policy. */
  id: string | undefined;
  /** Name of the policy. */
  name: string | undefined;
}

export interface ResourcePoolAttributes {
  /** STACKIT resource pool id. Stable across updates. */
  resourcePoolId: string;
  /** Project that owns the pool. */
  projectId: string;
  /** Region of the pool. */
  region: string;
  /** Name of the pool. */
  name: string;
  /** Availability zone of the pool. */
  availabilityZone: string | undefined;
  /** Performance class of the pool. */
  performanceClass: ResourcePoolPerformanceClass;
  /** Size of the pool in GB. */
  sizeGigabytes: number | undefined;
  /** CIDR ranges that can mount the pool read-only. */
  ipAcl: string[];
  /** Address to mount the whole pool read-only from, such as `10.2.1.1:/rp_VKL20Ub`. */
  mountPath: string | undefined;
  /** Snapshot policy of the pool, if any. */
  snapshotPolicy: ResourcePoolSnapshotPolicyRef | undefined;
  /** Whether mounting the pool shows its `.snapshot` directory. */
  snapshotsAreVisible: boolean | undefined;
  /** Number of shares in the pool. */
  countShares: number | undefined;
  /** Pool state; `created` after a deploy. */
  state: string | undefined;
  /** When the pool was created. */
  createdAt: string | undefined;
  /** When the size can be reduced again. */
  sizeReducibleAt: string | undefined;
  /** When the performance class can be downgraded again. */
  performanceClassDowngradableAt: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type ResourcePool = Resource<
  "Stackit.FileStorage.ResourcePool",
  ResourcePoolProps,
  ResourcePoolAttributes,
  never,
  Providers
>;

/**
 * A STACKIT File Storage resource pool: NFS capacity with a performance class in one
 * availability zone. Shares carve it up: {@link Share}.
 *
 * Size, performance class, IP ACL, snapshot policy, snapshot visibility and labels
 * update in place. **The name, availability zone, project and region replace the pool,
 * and a replacement starts empty: every share in it and all their data are lost**, so
 * copy data out first. Downstream shares are replaced with it. A generated name creates
 * the new pool first. An explicit name that stays the same has to delete the old pool
 * first, before anything has moved its shares away: that deploy fails with
 * `Stackit.FileStorage.ResourcePoolNotEmpty` until you take the shares out of the stack.
 *
 * Deleting a pool that still holds shares fails the same way, rather than taking data
 * this stack doesn't know about with it. Only `alchemy unsafe nuke` goes past that.
 *
 * A pool is billed per started hour by size and performance class, with a 500 GB minimum.
 *
 * Ownership is tracked with labels. A pool with the same name that lacks them is
 * reported as unowned and only taken over with `--adopt`.
 *
 * See [STACKIT's File Storage docs](https://docs.stackit.cloud/products/storage/file-storage/).
 *
 * :::caution[Changing `name`, `availabilityZone`, `projectId` or `region` replaces the Pool]
 * A replacement starts empty: every share in it and all their data are lost, so copy
 * data out first. Downstream shares are replaced with it.
 * :::
 *
 * ### Creating a Resource Pool
 * **Example:** The smallest pool
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * ```
 *
 * **Example:** A chosen name, snapshots and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   name: "orders-files",
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Premium",
 *   sizeGigabytes: 1000,
 *   ipAcl: ["10.0.0.0/24"],
 *   snapshotPolicyId: "9f2d3c1a-7e41-4c7b-8a55-0d7e8b6f1a22",
 *   snapshotsAreVisible: true,
 *   labels: { env: "production" },
 * });
 * ```
 *
 * ### Resizing a Resource Pool
 * **Example:** Growth updates in place
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A later shrink fails with `ResourcePoolChangeBlocked` until `sizeReducibleAt`.
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 750,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * ```
 *
 * ### Adding Shares
 * **Example:** A pool with one read-write share
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {
 *   rules: [{ order: 1, ipAcl: ["10.0.0.0/24"] }],
 * });
 * const share = yield* Stackit.FileStorage.Share("Assets", {
 *   resourcePoolId: pool.resourcePoolId,
 *   spaceHardLimitGigabytes: 100,
 *   exportPolicyName: policy.name,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving a pool to another zone loses its data
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new, empty pool: every share in the old one and all their data are deleted,
 * // and the shares declared on it come back empty.
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-2",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT File Storage
 * @category FileStorage
 */
export const ResourcePool = Resource<ResourcePool>("Stackit.FileStorage.ResourcePool");

/** A change STACKIT only allows again after a cooldown. Waiting it out here would stall the deploy. */
export class ResourcePoolChangeBlocked extends Data.TaggedError(
  "Stackit.FileStorage.ResourcePoolChangeBlocked",
)<{
  readonly resourcePoolId: string;
  readonly change: "shrink" | "downgrade";
  readonly allowedAt: string;
  readonly message: string;
}> {}

/** A pool still holds shares when it is deleted, whose data the delete would take. */
export class ResourcePoolNotEmpty extends Data.TaggedError(
  "Stackit.FileStorage.ResourcePoolNotEmpty",
)<{
  readonly resourcePoolId: string;
  readonly shares: ReadonlyArray<string>;
  readonly message: string;
}> {}

const toAttrs = (scope: FileStorageScope, pool: ObservedResourcePool): ResourcePoolAttributes => ({
  resourcePoolId: pool.id,
  projectId: scope.projectId,
  region: scope.region,
  name: pool.name ?? "",
  availabilityZone: pool.availabilityZone,
  performanceClass: {
    name: pool.performanceClass?.name,
    peakIops: pool.performanceClass?.peakIops,
    throughput: pool.performanceClass?.throughput,
  },
  sizeGigabytes: pool.space?.sizeGigabytes,
  ipAcl: [...(pool.ipAcl ?? [])],
  mountPath: pool.mountPath,
  snapshotPolicy:
    pool.snapshotPolicy === undefined || pool.snapshotPolicy === null
      ? undefined
      : { id: pool.snapshotPolicy.id, name: pool.snapshotPolicy.name },
  snapshotsAreVisible: pool.snapshotsAreVisible,
  countShares: pool.countShares,
  state: pool.state,
  createdAt: pool.createdAt,
  sizeReducibleAt: pool.sizeReducibleAt,
  performanceClassDowngradableAt: pool.performanceClassDowngradableAt,
  labels: stripInternalLabels(pool.labels),
});

type PoolPatch = Omit<sfs.UpdateResourcePoolRequest, "projectId" | "region" | "resourcePoolId">;

/** The delta between an observed pool and the desired props (empty when in sync). */
const poolDelta = (
  pool: ObservedResourcePool,
  news: ResourcePoolProps,
  olds: ResourcePoolProps | undefined,
  labels: Record<string, string>,
): PoolPatch => {
  const patch: PoolPatch = {};
  if (pool.performanceClass?.name !== news.performanceClass) {
    patch.performanceClass = news.performanceClass;
  }
  if (pool.space?.sizeGigabytes !== news.sizeGigabytes) patch.sizeGigabytes = news.sizeGigabytes;
  if (!sameMembers(pool.ipAcl, news.ipAcl)) patch.ipAcl = [...news.ipAcl];
  // `""` is how the API removes a policy. Unset leaves it, so a pool that never set
  // this prop (an adopted one) keeps what it has.
  const policyId = news.snapshotPolicyId ?? (olds?.snapshotPolicyId !== undefined ? "" : undefined);
  if (policyId !== undefined && (pool.snapshotPolicy?.id ?? "") !== policyId) {
    patch.snapshotPolicyId = policyId;
  }
  if (
    news.snapshotsAreVisible !== undefined &&
    pool.snapshotsAreVisible !== news.snapshotsAreVisible
  ) {
    patch.snapshotsAreVisible = news.snapshotsAreVisible;
  }
  if (labelsChanged(pool.labels, labels)) patch.labels = labels;
  return patch;
};

/** Whether moving from class `from` to class `to` lowers the IOPS, by STACKIT's own list. */
const isDowngrade = (from: string | undefined, to: string) =>
  sfs.listPerformanceClasses({}).pipe(
    Effect.map(({ performanceClasses }) => {
      const iopsOf = (name: string | undefined) =>
        performanceClasses?.find((candidate) => candidate.name === name)?.iops;
      const fromIops = iopsOf(from);
      const toIops = iopsOf(to);
      return fromIops !== undefined && toIops !== undefined && toIops < fromIops;
    }),
  );

/** Fail typed when a patch would hit one of the pool's cooldowns. */
const assertChangeAllowed = (pool: ObservedResourcePool, patch: PoolPatch) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const blocked = (at: string | undefined) => at !== undefined && Date.parse(at) > now;
    const size = pool.space?.sizeGigabytes;
    if (
      typeof patch.sizeGigabytes === "number" &&
      size !== undefined &&
      patch.sizeGigabytes < size &&
      blocked(pool.sizeReducibleAt)
    ) {
      return yield* new ResourcePoolChangeBlocked({
        resourcePoolId: pool.id,
        change: "shrink",
        allowedAt: pool.sizeReducibleAt!,
        message: `Resource pool ${pool.id} can't shrink from ${size} GB to ${patch.sizeGigabytes} GB until ${pool.sizeReducibleAt}`,
      });
    }
    if (
      patch.performanceClass !== undefined &&
      blocked(pool.performanceClassDowngradableAt) &&
      (yield* isDowngrade(pool.performanceClass?.name, patch.performanceClass))
    ) {
      return yield* new ResourcePoolChangeBlocked({
        resourcePoolId: pool.id,
        change: "downgrade",
        allowedAt: pool.performanceClassDowngradableAt!,
        message: `Resource pool ${pool.id} can't move to the lower performance class ${patch.performanceClass} until ${pool.performanceClassDowngradableAt}`,
      });
    }
  });

/**
 * Wait for the pool's shares to go, then refuse if any are left. A share a destroy
 * deleted is gone by now. What remains is someone else's, or a share of this stack
 * that a delete-first replacement of its pool hasn't reached.
 */
const assertNoShares = (scope: FileStorageScope, resourcePoolId: string) =>
  Effect.gen(function* () {
    const settled = yield* waitUntilGone({
      resource: `the shares of STACKIT File Storage resource pool ${resourcePoolId}`,
      read: listPoolShares(scope, resourcePoolId).pipe(
        Effect.map((shares) => (shares.length === 0 ? undefined : shares)),
      ),
      timeout: SETTLE_TIMEOUT,
    }).pipe(
      Effect.as(true),
      Effect.catchTag("Stackit.WaitTimeout", () => Effect.succeed(false)),
    );
    if (settled) return;
    const shares = yield* listPoolShares(scope, resourcePoolId);
    if (shares.length === 0) return;
    const names = shares.map((share) => share.name ?? share.id);
    return yield* new ResourcePoolNotEmpty({
      resourcePoolId,
      shares: names,
      message: `Resource pool ${resourcePoolId} still holds shares: ${names.join(", ")}. Deleting it would delete their data. Delete the shares or take them out of the stack first.`,
    });
  });

export const ResourcePoolProvider = () =>
  Provider.succeed(ResourcePool, {
    // A share reads `resourcePoolId` as a replace trigger. It has to stay resolved through
    // a resize, or every small edit of the pool would replace, and so empty, its shares.
    stables: ["resourcePoolId", "projectId", "region", "name", "availabilityZone"],
    // Nuke ordering: `Share` and `ResourcePoolSnapshot` declare a dependency on this
    // type, so they go first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const pools = yield* listAllPools(scope);
      return pools
        .filter((pool) => isAlchemyOwned(pool.labels))
        .map((pool) => toAttrs(scope, pool));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name can resolve to the one the pool has, and a name can't exist
      // twice in a project and region: the old pool goes first. A generated name carries
      // the generation, so the new pool can come up first.
      if (
        hasUnresolvedTrigger<ResourcePoolProps>(news, [
          "name",
          "availabilityZone",
          "projectId",
          "region",
        ])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<ResourcePoolProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ResourcePoolProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const nameChanged = resolved.name !== undefined && resolved.name !== output.name;
      // The props last deployed first: the API may answer a zone in another form, and an
      // unchanged deploy must not replace, and so empty, the pool.
      const deployedZone = olds?.availabilityZone ?? output.availabilityZone;
      const zoneChanged = deployedZone !== undefined && resolved.availabilityZone !== deployedZone;
      if (scopeChanged || nameChanged || zoneChanged) {
        return {
          action: "replace",
          deleteFirst: resolved.name !== undefined && !scopeChanged && !nameChanged,
        } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.resourcePoolId !== undefined) {
        const byId = yield* getPoolOrUndefined(scope, output.resourcePoolId);
        if (byId !== undefined && byId.state !== "deleting") return toAttrs(scope, byId);
      }
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* findPoolByName(scope, name);
      if (found === undefined || found.state === "deleting") return undefined;
      const attrs = toAttrs(scope, found);
      // The generation being replaced, matched by id: a name only means something
      // within one project and region.
      if (previous?.resourcePoolId === found.id) return attrs;
      // A generated name holds this generation's instance id.
      if (name === generated) return attrs;
      // A crashed create has neither state nor a previous generation, and any
      // generation of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      const owned =
        (yield* hasAlchemyLabels(id, found.labels)) &&
        (generation === undefined || hasInstanceLabel(generation, found.labels));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const generated = yield* generatedName(id);
      const name = news.name ?? output?.name ?? generated;
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const isThisGeneration = (found: ObservedResourcePool) =>
        Effect.gen(function* () {
          if (name === generated) return true;
          return (
            (yield* hasAlchemyLabels(id, found.labels)) &&
            hasInstanceLabel(instanceId, found.labels)
          );
        });

      // 1. Observe — `output` is a cache for the id, and only names the desired pool
      // while it sits in the same project and region. Without it, only this generation's
      // pool can be claimed: a same-named pool of another generation, or a foreign one,
      // is never taken over here.
      let current: ObservedResourcePool | undefined;
      if (
        output?.resourcePoolId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getPoolOrUndefined(scope, output.resourcePoolId);
      }
      if (current === undefined) {
        const named = yield* findPoolByName(scope, name);
        if (named !== undefined && (yield* isThisGeneration(named))) current = named;
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForPoolGone(scope, current.id, (state) => state === "error");
        current = undefined;
      }

      // 2. Ensure
      if (current === undefined) {
        const created = yield* sfs
          .createResourcePool({
            ...scope,
            name,
            availabilityZone: news.availabilityZone,
            performanceClass: news.performanceClass,
            sizeGigabytes: news.sizeGigabytes,
            ipAcl: [...news.ipAcl],
            labels,
            ...(news.snapshotPolicyId !== undefined
              ? { snapshotPolicyId: news.snapshotPolicyId }
              : {}),
            ...(news.snapshotsAreVisible !== undefined
              ? { snapshotsAreVisible: news.snapshotsAreVisible }
              : {}),
          })
          .pipe(
            Effect.flatMap(requirePool),
            // Lost a race against our own create: observe it. Anything else holding
            // the name is not ours, and still fails.
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const found = yield* findPoolByName(scope, name);
                return found !== undefined && (yield* isThisGeneration(found))
                  ? found
                  : yield* Effect.fail(error);
              }),
            ),
          );
        current = yield* waitForPool(scope, created.id);
      } else if (current.state !== "created") {
        current = yield* waitForPool(scope, current.id);
      }
      const liveId = current.id;

      // 3. Sync — one PATCH with every drifted aspect, diffed against the observed pool.
      // Waiting for the new values too means a read from before the PATCH can't pass.
      // Label removals aren't awaited: whether a PATCH replaces or merges the map is
      // undocumented, and a merge must not stall the deploy.
      const delta = poolDelta(current, news, olds, labels);
      if (Object.keys(delta).length > 0) {
        yield* assertChangeAllowed(current, delta);
        yield* sfs.updateResourcePool({ ...scope, resourcePoolId: liveId, ...delta });
        current = yield* waitForPool(scope, liveId, (observed) => {
          const { labels: _labels, ...rest } = poolDelta(observed, news, olds, labels);
          return Object.keys(rest).length === 0;
        });
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const current = yield* getPoolOrUndefined(scope, output.resourcePoolId);
      if (current === undefined) return;
      if (current.state === "deleting") {
        return yield* waitForPoolGone(scope, current.id, (state) => state === "error");
      }
      // Only `alchemy unsafe nuke` deletes a pool past shares that are still there.
      if (!force) yield* assertNoShares(scope, current.id);
      const alreadyFailed = current.state === "error";
      yield* sfs.deleteResourcePool({ ...scope, resourcePoolId: current.id }).pipe(
        Effect.retry(poolConflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      // The SDK's delete handler fails on `error`. A pool that was in it before the
      // delete can sit there until it's gone, so the budget decides.
      yield* waitForPoolGone(scope, current.id, (state) => state === "error" && !alreadyFailed);
    }),
  });
