import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import { ensureObjectStorageEnabled } from "./internal.ts";

export interface ComplianceLockProps {
  /**
   * Project to lock. Defaults to the profile's project. Changing it
   * replaces the lock.
   */
  projectId?: string;
  /**
   * Region of the lock. Defaults to the profile's region (`eu01`).
   * Changing it replaces the lock.
   */
  region?: string;
}

export type ComplianceLock = Resource<
  "Stackit.ObjectStorage.ComplianceLock",
  ComplianceLockProps,
  {
    /** Project the lock applies to. */
    projectId: string;
    /** Region of the lock. */
    region: string;
    /** Longest retention, in days, a bucket's Object Lock retention may use. */
    maxRetentionDays: number;
  },
  never,
  Providers
>;

/**
 * The project-level Object Storage compliance lock. It must be active
 * before a {@link Bucket} can be created with `objectLockEnabled: true`, and
 * caps the retention period buckets may use (`maxRetentionDays`).
 *
 * There is one lock per project and region. Ownership: the lock has no
 * labels, so an existing lock that is not in the stack's state is reported
 * as unowned and only taken over with `--adopt`. Deleting the lock removes
 * it for the whole project; `alchemy unsafe nuke` skips this type.
 *
 * See [STACKIT's Object Storage docs](https://docs.stackit.cloud/products/storage/object-storage/).
 *
 * :::caution[Changing `projectId` or `region` replaces the Lock]
 * A deploy deletes the old lock. STACKIT may refuse to remove a lock while Object Lock
 * buckets still exist in the project; delete those buckets first.
 * :::
 *
 * ### Enabling Object Lock for a project
 * **Example:** Compliance lock plus an Object Lock bucket
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const lock = yield* Stackit.ObjectStorage.ComplianceLock("Lock", {});
 * const archive = yield* Stackit.ObjectStorage.Bucket("Archive", {
 *   // referencing the lock orders the bucket after it (and deletes it first)
 *   projectId: lock.projectId,
 *   objectLockEnabled: true,
 * });
 * ```
 *
 * **Example:** Compliance lock in another project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const lock = yield* Stackit.ObjectStorage.ComplianceLock("ArchiveLock", {
 *   projectId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Object Storage
 * @category Storage
 */
export const ComplianceLock = Resource<ComplianceLock>("Stackit.ObjectStorage.ComplianceLock");

type Attributes = ComplianceLock["Attributes"];

const getLock = (projectId: string, region: string) =>
  objectStorage.getComplianceLock({ projectId, region }).pipe(
    Effect.map((lock): Attributes => ({
      projectId,
      region,
      maxRetentionDays: lock.maxRetentionDays,
    })),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const ComplianceLockProvider = () =>
  Provider.succeed(ComplianceLock, {
    stables: ["projectId", "region"],
    // One lock per project, no ownership marker, project-wide effect.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // One lock per project and region: delete-first, since an unresolved
      // scope can resolve to the current one.
      if (hasUnresolvedTrigger<ComplianceLockProps>(news, ["projectId", "region"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<ComplianceLockProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const region = output?.region ?? olds?.region ?? env.region;
      const lock = yield* getLock(projectId, region);
      if (lock === undefined) return undefined;
      return output !== undefined ||
        (previous?.projectId === projectId && previous.region === region)
        ? lock
        : Unowned(lock);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;

      yield* ensureObjectStorageEnabled({ projectId, region });

      // Observe -> ensure. A conflict means the lock already exists.
      const existing = yield* getLock(projectId, region);
      if (existing !== undefined) return existing;
      const created = yield* objectStorage.createComplianceLock({ projectId, region }).pipe(
        Effect.map((lock): Attributes => ({
          projectId,
          region,
          maxRetentionDays: lock.maxRetentionDays,
        })),
        Effect.catchTag("Conflict", () => Effect.undefined),
      );
      if (created !== undefined) return created;
      const observed = yield* waitFor({
        resource: `STACKIT compliance lock in project ${projectId} (${region})`,
        read: getLock(projectId, region),
        ready: (lock) => lock !== undefined,
        timeout: "30 seconds",
      });
      // `ready` guarantees a defined lock.
      return observed ?? { projectId, region, maxRetentionDays: 0 };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* objectStorage
        .deleteComplianceLock({ projectId: output.projectId, region: output.region })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
