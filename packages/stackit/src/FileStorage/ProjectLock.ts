import * as sfs from "@distilled.cloud/stackit/sfs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import type { FileStorageScope } from "./internal.ts";

export interface ProjectLockProps {
  /**
   * Project to lock. Changing it replaces the lock: the new project is locked and the
   * old one unlocked.
   *
   * @default the profile's project
   */
  projectId?: string;
  /**
   * Region to lock. Changing it replaces the lock.
   *
   * @default the profile's region
   */
  region?: string;
}

export interface ProjectLockAttributes {
  /** Id of the lock. */
  lockId: string;
  /** The locked project. */
  projectId: string;
  /** The region the lock applies to. */
  region: string;
}

export type ProjectLock = Resource<
  "Stackit.FileStorage.ProjectLock",
  ProjectLockProps,
  ProjectLockAttributes,
  never,
  Providers
>;

/**
 * The File Storage lock of a project and region. STACKIT needs it for immutable
 * snapshots (`snaplockRetentionHours` on a {@link ResourcePoolSnapshot}) and to prevent
 * accidental deletion. There is at most one per project and region.
 *
 * A lock this stack didn't enable is reported as unowned and only taken over with
 * `--adopt`, because destroying it removes someone else's protection. A deploy that
 * crashes between enabling the lock and saving state looks the same on the next run:
 * redeploy with `--adopt`.
 *
 * Destroying it disables the lock, which STACKIT requires before the project can be
 * deleted. A lock costs nothing.
 *
 * ### Locking a Project
 * **Example:** The profile's project and region
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const lock = yield* Stackit.FileStorage.ProjectLock("Lock", {});
 * ```
 *
 * **Example:** A chosen project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const lock = yield* Stackit.FileStorage.ProjectLock("Lock", {
 *   projectId: "6d7d9c8e-2f1b-4c5a-9e3d-8b7a6f5e4d3c",
 *   region: "eu01",
 * });
 * ```
 *
 * ### Immutable Snapshots
 * **Example:** A snapshot nobody can delete for a day
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
 * const snapshot = yield* Stackit.FileStorage.ResourcePoolSnapshot("Before", {
 *   resourcePoolId: pool.resourcePoolId,
 *   snaplockRetentionHours: 24,
 * });
 * ```
 *
 * @resource
 * @product STACKIT File Storage
 * @category FileStorage
 */
export const ProjectLock = Resource<ProjectLock>("Stackit.FileStorage.ProjectLock");

/** The API answered without a lock id after a lock was enabled. */
export class ProjectLockUnconfirmed extends Data.TaggedError(
  "Stackit.FileStorage.ProjectLockUnconfirmed",
)<{
  readonly projectId: string;
  readonly region: string;
  readonly message: string;
}> {}

/**
 * The lock's id, `undefined` when the project isn't locked. An unlocked project may
 * answer 200 with no id or a 404: the spec documents only the first, the Terraform
 * provider handles the second, so both mean no lock.
 */
const observeLockId = (scope: FileStorageScope) =>
  sfs.getLock(scope).pipe(
    Effect.map((response) => response.lockId),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const ProjectLockProvider = () =>
  Provider.succeed(ProjectLock, {
    stables: ["projectId", "region"],
    // No `list`: a lock has no labels, so nothing tells ours from someone else's, and
    // `alchemy unsafe nuke` must not remove a protection it didn't set.

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // A lock has no identity beyond its scope, and an unresolved scope can resolve to
      // the one it already holds: release it first.
      if (hasUnresolvedTrigger<ProjectLockProps>(news, ["projectId", "region"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<ProjectLockProps>(news);
      if (yield* projectScopeChanged(resolved, output)) return { action: "replace" } as const;
      // Nothing else to update.
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const lockId = yield* observeLockId(scope);
      if (lockId === undefined) return undefined;
      const attrs = { ...scope, lockId };
      // Ours only at the scope recorded: the same call elsewhere finds another lock.
      const atScopeOf = (recorded: ProjectLockAttributes | undefined) =>
        recorded?.projectId === scope.projectId && recorded.region === scope.region;
      return atScopeOf(output) || atScopeOf(previous) ? attrs : Unowned(attrs);
    }),

    // Existence only: observe, and enable when there is no lock.
    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const lockId =
        (yield* observeLockId(scope)) ??
        (yield* sfs.enableLock(scope).pipe(
          Effect.map((response) => response.lockId),
          // Already locked: a race, so read the lock that won it.
          Effect.catchTag("Conflict", () => observeLockId(scope)),
        ));
      if (lockId === undefined) {
        return yield* new ProjectLockUnconfirmed({
          ...scope,
          message: `STACKIT didn't report a File Storage lock on project ${scope.projectId} in ${scope.region} after enabling it`,
        });
      }
      return { ...scope, lockId };
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const lockId = yield* observeLockId(scope);
      // Already disabled, or a lock someone enabled since: only remove the one recorded.
      if (lockId !== output.lockId) return;
      yield* sfs.disableLock(scope);
    }),
  });
