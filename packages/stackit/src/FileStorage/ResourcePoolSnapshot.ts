import * as sfs from "@distilled.cloud/stackit/sfs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { isAlchemyOwned } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type FileStorageScope,
  GENERATED_NAME_MAX_LENGTH,
  generatedName,
  listAllPools,
  listPoolSnapshots,
  SETTLE_TIMEOUT,
} from "./internal.ts";

export interface ResourcePoolSnapshotProps {
  /**
   * Resource pool to snapshot. Changing it replaces the snapshot: a new one of the other
   * pool is taken, and **the old one and the data it held are deleted**. A pool that is
   * itself replaced replaces its snapshots.
   */
  resourcePoolId: string;
  /**
   * Name of the snapshot. Renames in place, so the captured content stays. Removing an
   * explicit name keeps the snapshot under the name it has.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /** A comment on the snapshot. Updates in place. */
  comment?: string;
  /**
   * Hours nobody can delete the snapshot, at most 30 days. It needs a
   * {@link ProjectLock}. Changing it replaces the snapshot: a new one is taken, capturing
   * the pool as it is now, and **the old one is deleted**, which STACKIT refuses while
   * its retention holds.
   */
  snaplockRetentionHours?: number;
  /**
   * Project that owns the pool. Changing it replaces the snapshot.
   *
   * @default the profile's project
   */
  projectId?: string;
  /**
   * Region of the pool. Changing it replaces the snapshot.
   *
   * @default the profile's region
   */
  region?: string;
}

export interface ResourcePoolSnapshotAttributes {
  /** Name of the snapshot, which is how the API addresses it. */
  snapshotName: string;
  /** Resource pool of the snapshot. */
  resourcePoolId: string;
  /** Project that owns the pool. */
  projectId: string;
  /** Region of the pool. */
  region: string;
  /** Comment on the snapshot, if any. */
  comment: string | undefined;
  /** When the snapshot was taken. */
  createdAt: string | undefined;
  /** How much of the pool's storage the snapshot takes up, in GB. */
  sizeGigabytes: number | undefined;
  /** User-visible size of the data in the snapshot, in GB. */
  logicalSizeGigabytes: number | undefined;
  /** When the snapshot's retention ends, if it has one. */
  snaplockExpiryTime: string | undefined;
}

export type ResourcePoolSnapshot = Resource<
  "Stackit.FileStorage.ResourcePoolSnapshot",
  ResourcePoolSnapshotProps,
  ResourcePoolSnapshotAttributes,
  never,
  Providers
>;

/**
 * A manual snapshot of a STACKIT File Storage {@link ResourcePool}, capturing every share
 * in it at one moment. Mounting the pool shows it in `.snapshot` when the pool's
 * `snapshotsAreVisible` is on.
 *
 * The comment and the name update in place. **A replacement takes a new snapshot of the
 * pool as it is now and deletes the old one, so what it captured is lost:** the pool, the
 * retention, the project and the region replace it. Destroying a snapshot, or its pool,
 * deletes it. A snapshot with `snaplockRetentionHours` can't be deleted until its
 * retention ends, so destroying it before then fails with
 * `Stackit.FileStorage.SnapshotLocked`.
 *
 * A snapshot has no labels. Its name in state is what Alchemy deletes, and a generated
 * name marks it as Alchemy's. Under an explicit name, a snapshot found with no state is
 * reported as unowned and only taken over with `--adopt`.
 *
 * A snapshot uses its pool's space and has no charge of its own.
 *
 * See [STACKIT's File Storage docs](https://docs.stackit.cloud/products/storage/file-storage/).
 *
 * :::caution[Changing `resourcePoolId`, `snaplockRetentionHours`, `projectId` or `region` replaces the Snapshot]
 * A replacement takes a new snapshot of the pool as it is now and deletes the old one,
 * so what it captured is lost.
 * :::
 *
 * ### Taking a Snapshot
 * **Example:** A snapshot with a comment
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const snapshot = yield* Stackit.FileStorage.ResourcePoolSnapshot("BeforeMigration", {
 *   resourcePoolId: pool.resourcePoolId,
 *   comment: "before the v2 migration",
 * });
 * ```
 *
 * ### Immutable Snapshots
 * **Example:** A snapshot nobody can delete for a week
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.FileStorage.ProjectLock("Lock", {});
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const snapshot = yield* Stackit.FileStorage.ResourcePoolSnapshot("Audit", {
 *   resourcePoolId: pool.resourcePoolId,
 *   name: "audit-2026-q4",
 *   snaplockRetentionHours: 168,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the retention captures the pool again
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * // Not the same data: the new snapshot holds the pool as it is at this deploy, and
 * // the old one is deleted. Declare a second snapshot to keep both.
 * const snapshot = yield* Stackit.FileStorage.ResourcePoolSnapshot("Audit", {
 *   resourcePoolId: pool.resourcePoolId,
 *   snaplockRetentionHours: 48,
 * });
 * ```
 *
 * @resource
 * @product STACKIT File Storage
 * @category FileStorage
 */
export const ResourcePoolSnapshot = Resource<ResourcePoolSnapshot>(
  "Stackit.FileStorage.ResourcePoolSnapshot",
);

/** STACKIT refuses to delete a snapshot while its retention holds. Waiting it out here would stall the deploy. */
export class SnapshotLocked extends Data.TaggedError("Stackit.FileStorage.SnapshotLocked")<{
  readonly resourcePoolId: string;
  readonly snapshotName: string;
  readonly snaplockExpiryTime: string;
  readonly message: string;
}> {}

const toAttrs = (
  scope: FileStorageScope,
  resourcePoolId: string,
  snapshotName: string,
  snapshot: sfs.ResourcePoolSnapshot,
): ResourcePoolSnapshotAttributes => ({
  snapshotName,
  resourcePoolId,
  projectId: scope.projectId,
  region: scope.region,
  comment: snapshot.comment ?? undefined,
  createdAt: snapshot.createdAt,
  sizeGigabytes: snapshot.sizeGigabytes,
  logicalSizeGigabytes: snapshot.logicalSizeGigabytes,
  snaplockExpiryTime: snapshot.snaplockExpiryTime ?? undefined,
});

/**
 * The snapshot with this name. Read through the list: no source documents what the
 * single-snapshot read answers for a missing one, and the list has a typed answer for a
 * missing pool.
 */
const findSnapshot = (scope: FileStorageScope, resourcePoolId: string, snapshotName: string) =>
  listPoolSnapshots(scope, resourcePoolId).pipe(
    Effect.map((snapshots) => snapshots.find((s) => s.snapshotName === snapshotName)),
  );

export const ResourcePoolSnapshotProvider = () =>
  Provider.succeed(ResourcePoolSnapshot, {
    stables: ["resourcePoolId", "projectId", "region"],
    // A snapshot has to go before its pool. Scheduled snapshots are the pool's own.
    nuke: { dependsOn: ["Stackit.FileStorage.ResourcePool"] },

    // Snapshots have no labels: a generated name in a pool Alchemy owns marks them.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const pools = yield* listAllPools(scope);
      const attrs: ResourcePoolSnapshotAttributes[] = [];
      for (const pool of pools) {
        if (!isAlchemyOwned(pool.labels)) continue;
        const snapshots = yield* listPoolSnapshots(scope, pool.id);
        for (const snapshot of snapshots) {
          const name = snapshot.snapshotName;
          if (name !== undefined && isGeneratedPhysicalName(name, GENERATED_NAME_MAX_LENGTH)) {
            attrs.push(toAttrs(scope, pool.id, name, snapshot));
          }
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name can stay the same, and a name can't exist twice in a pool: the
      // old snapshot goes first. A generated name carries the generation.
      if (
        hasUnresolvedTrigger<ResourcePoolSnapshotProps>(news, [
          "resourcePoolId",
          "snaplockRetentionHours",
          "projectId",
          "region",
        ])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<ResourcePoolSnapshotProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ResourcePoolSnapshotProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const poolChanged = resolved.resourcePoolId !== output.resourcePoolId;
      // Not a trigger, so it may be unresolved here: then it isn't known to differ.
      const rawName = rawProp<ResourcePoolSnapshotProps>(news, "name");
      const nameChanged = typeof rawName === "string" && rawName !== output.snapshotName;
      // Compared with the props last deployed: an adoption can't know what a snapshot
      // was asked for, and the API only reports the resulting expiry. An unchanged deploy
      // must not replace, and so lose, a snapshot.
      const retentionChanged =
        olds !== undefined && resolved.snaplockRetentionHours !== olds.snaplockRetentionHours;
      if (scopeChanged || poolChanged || retentionChanged) {
        return {
          action: "replace",
          deleteFirst: rawName !== undefined && !scopeChanged && !poolChanged && !nameChanged,
        } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const resourcePoolId = output?.resourcePoolId ?? olds?.resourcePoolId;
      if (resourcePoolId === undefined) return undefined;
      const generated = yield* generatedName(id);
      const name = output?.snapshotName ?? olds?.name ?? generated;
      const found = yield* findSnapshot(scope, resourcePoolId, name);
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, resourcePoolId, name, found);
      const isRecorded = (recorded: ResourcePoolSnapshotAttributes | undefined) =>
        recorded?.snapshotName === name &&
        recorded.resourcePoolId === resourcePoolId &&
        recorded.projectId === scope.projectId &&
        recorded.region === scope.region;
      // Recorded by us at this very scope, or carrying this generation's instance id.
      // Anything else under that name was found with no state, and has no labels.
      return isRecorded(output) || isRecorded(previous) || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const { resourcePoolId } = news;
      const generated = yield* generatedName(id);
      const recorded =
        output !== undefined &&
        output.resourcePoolId === resourcePoolId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output.snapshotName
          : undefined;
      const name = news.name ?? recorded ?? generated;

      // 1. Observe — the recorded name, which may differ from the desired one before a
      // rename. Without a record only this generation's generated name can be claimed:
      // `read` gated the rest, and a snapshot has no labels to prove anything by.
      let observedName = recorded ?? name;
      let current =
        recorded !== undefined || name === generated
          ? yield* findSnapshot(scope, resourcePoolId, observedName)
          : undefined;

      // 2. Ensure
      if (current === undefined) {
        observedName = name;
        current = yield* sfs
          .createResourcePoolSnapshot({
            ...scope,
            resourcePoolId,
            name,
            ...(news.comment !== undefined ? { comment: news.comment } : {}),
            ...(news.snaplockRetentionHours !== undefined
              ? { snaplockRetentionHours: news.snaplockRetentionHours }
              : {}),
          })
          .pipe(
            Effect.map((response): sfs.ResourcePoolSnapshot => response.resourcePoolSnapshot ?? {}),
            // Lost a race against our own create, under this generation's name. Anything
            // else holding the name is not ours, and still fails.
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const found = yield* findSnapshot(scope, resourcePoolId, name);
                return found !== undefined && name === generated
                  ? found
                  : yield* Effect.fail(error);
              }),
            ),
          );
      }

      // 3. Sync — observed against desired. Clearing a comment sends `""`: null means
      // "leave it". A prop never set leaves an adopted snapshot's comment alone.
      const comment = news.comment ?? (olds?.comment !== undefined ? "" : undefined);
      const commentDiffers = comment !== undefined && (current.comment ?? "") !== comment;
      const nameDiffers = observedName !== name;
      if (commentDiffers || nameDiffers) {
        const updated = yield* sfs.updateResourcePoolSnapshot({
          ...scope,
          resourcePoolId,
          snapshotName: observedName,
          ...(commentDiffers ? { comment } : {}),
          ...(nameDiffers ? { name } : {}),
        });
        current = updated.resourcePoolSnapshot ?? current;
        observedName = name;
      }

      // 4. Return
      return toAttrs(scope, resourcePoolId, observedName, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { resourcePoolId, snapshotName } = output;
      const current = yield* findSnapshot(scope, resourcePoolId, snapshotName);
      if (current === undefined) return;
      const { snaplockExpiryTime } = current;
      yield* sfs.deleteResourcePoolSnapshot({ ...scope, resourcePoolId, snapshotName }).pipe(
        Effect.catchTag("Conflict", (error) =>
          Effect.gen(function* () {
            // A 409 with a retention on it is the lock. Don't wait that out.
            if (snaplockExpiryTime === undefined || snaplockExpiryTime === null) {
              return yield* Effect.fail(error);
            }
            return yield* new SnapshotLocked({
              resourcePoolId,
              snapshotName,
              snaplockExpiryTime,
              message: `Snapshot ${snapshotName} of resource pool ${resourcePoolId} can't be deleted until ${snaplockExpiryTime}`,
            });
          }),
        ),
      );
      yield* waitUntilGone({
        resource: `snapshot ${snapshotName} of STACKIT File Storage resource pool ${resourcePoolId}`,
        read: findSnapshot(scope, resourcePoolId, snapshotName),
        timeout: SETTLE_TIMEOUT,
      });
    }),
  });
