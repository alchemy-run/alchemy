import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import {
  DEV_TIMESTAMP,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  type GetBucketsResponse,
  deleteBucket,
  getBuckets,
  getBucket,
  createBucket,
  updateBucket,
} from "@distilled.cloud/prisma/management";
import { Retry } from "@distilled.cloud/prisma";
import { desiredBranchId } from "./Internal/Branches.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { ObservedBucket } from "./Internal/Observed.ts";
import { PrismaPaginationError } from "./Internal/Pagination.ts";

export interface BucketProps {
  /**
   * Project ID or `project.projectId` output that owns this bucket.
   */
  project: string | Project;
  /**
   * Bucket display name. Prisma generates a name when omitted. The display
   * name is not the provider-side S3 bucket name — S3 clients must use the
   * `bucketName` attribute of `Prisma.BucketAccessKey`.
   */
  name?: string;
  /**
   * Branch ID to scope the bucket to, e.g. for per-branch preview storage.
   * Every bucket belongs to a branch: omit it to let the Management API attach
   * the bucket to the project's default branch, which Alchemy then leaves
   * unmanaged.
   */
  branchId?: string;
  /**
   * Stable identity of this declaration on the Prisma platform, unique per
   * branch. When set, the provider finds the bucket by it within the project
   * and branch, never by display name, so lost state or a rename in the
   * Console does not create a second bucket. Changing it updates the bucket
   * in place.
   */
  logicalId?: string;
}

export interface Bucket extends Resource<
  "Prisma.Bucket",
  BucketProps,
  {
    /**
     * Prisma bucket ID.
     */
    bucketId: string;
    /**
     * Bucket display name. Not the provider-side S3 bucket name; S3 clients
     * must use the `bucketName` attribute of `Prisma.BucketAccessKey`.
     */
    name: string;
    /**
     * Project ID that owns the bucket.
     */
    projectId: string;
    /**
     * ISO timestamp when the bucket was created.
     */
    createdAt: string;
    /**
     * Logical ID recorded on the bucket, or null when none is set.
     */
    logicalId: string | null;
  },
  never,
  Providers
> {}

/**
 * A Prisma Object Store bucket inside a Prisma project.
 *
 * A project change replaces the bucket. Display name, branch, and logical ID
 * changes update it in place; the display name is a label only, so the
 * provider-side bucket name, its objects, and its access keys stay the same.
 * Destroying this resource deletes the bucket, its objects, and any remaining
 * access keys — the Management API cascades the deletion server-side.
 *
 * ### Creating a Bucket
 * **Example:** Bucket in a project
 * ```typescript
 * const bucket = yield* Prisma.Bucket("uploads", {
 *   project,
 *   name: "uploads",
 * });
 * ```
 *
 * ### Accessing a Bucket
 * **Example:** S3 credentials for a bucket
 * ```typescript
 * const key = yield* Prisma.BucketAccessKey("uploads-key", {
 *   bucket,
 *   role: "read_write",
 * });
 * ```
 *
 * @resource
 * @product Bucket
 */
export const Bucket = Resource<Bucket>("Prisma.Bucket");

/**
 * The bucket the provider observed belongs to a different project than the
 * one requested or persisted. Convergence and deletion both refuse rather
 * than acting on a bucket that is not the one this resource manages.
 */
export class BucketProjectMismatchError extends Data.TaggedError(
  "BucketProjectMismatchError",
)<{
  bucketId: string;
  actualProjectId: string;
  expectedProjectId: string;
  message: string;
}> {}

const logicalIdTaken = (
  logicalId: string,
  branchId: string | null | undefined,
  projectId: string,
  cause: unknown,
) =>
  new Error(
    `Prisma bucket logical ID '${logicalId}' is already used by another bucket on ${branchId ? `branch '${branchId}'` : "the project's default branch"} in project '${projectId}'. Logical IDs are unique per branch; choose a different logicalId or remove it from the other bucket.`,
    { cause },
  );

const attrsFrom = (bucket: ObservedBucket): Bucket["Attributes"] => ({
  bucketId: bucket.id,
  name: bucket.name,
  projectId: bucket.project.id,
  createdAt: bucket.createdAt,
  logicalId: bucket.logicalId ?? null,
});

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listBuckets = (
  filter: { projectId?: string; logicalId?: string; branchId?: string } = {},
) =>
  Effect.gen(function* () {
    const buckets: GetBucketsResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getBuckets(
        cursor === undefined ? filter : { ...filter, cursor },
      );
      buckets.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* Effect.fail(
          new PrismaPaginationError({
            message:
              "Invalid Prisma Management API pagination response from getBuckets: hasMore was true without a non-empty nextCursor",
          }),
        );
      }
      cursor = nextCursor;
    }
    return buckets;
  });

const findBucketByLogicalId = Effect.fn(function* (
  projectId: string,
  logicalId: string,
  branchId: string | undefined,
) {
  const branch = yield* desiredBranchId(projectId, { branchId });
  if (!branch.resolved) return undefined;
  const buckets = yield* listBuckets({
    projectId,
    logicalId,
    branchId: branch.id,
  });
  return buckets.find(
    (bucket) => bucket.logicalId === logicalId && bucket.branchId === branch.id,
  );
});

const ProviderLive = () =>
  Provider.effect(
    Bucket,
    Effect.gen(function* () {
      return {
        stables: ["bucketId"],
        list: () =>
          listBuckets().pipe(Effect.map((buckets) => buckets.map(attrsFrom))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.bucketId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (concreteIdsChanged(oldProjectId, newProjectId)) {
            return { action: "replace" } as const;
          }
          if (
            isResolved(news.branchId) &&
            news.branchId !== undefined &&
            news.branchId !== olds.branchId
          ) {
            return { action: "update" } as const;
          }
          if (
            isResolved(news.name) &&
            news.name !== undefined &&
            news.name !== (output?.name ?? olds.name)
          ) {
            return { action: "update" } as const;
          }
          if (
            isResolved(news.logicalId) &&
            news.logicalId !== undefined &&
            news.logicalId !== (output ? output.logicalId : olds.logicalId)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const bucketId = isPrismaDevId(output?.bucketId)
            ? undefined
            : output?.bucketId;
          if (!bucketId) {
            const projectId = unresolvedProjectIdOf(olds.project);
            if (!projectId || olds.logicalId === undefined) return undefined;
            // Only a declaration assigns a logical ID, so a match is this
            // bucket.
            const bucket = yield* findBucketByLogicalId(
              projectId,
              olds.logicalId,
              olds.branchId,
            );
            return bucket ? attrsFrom(bucket) : undefined;
          }
          const bucket = yield* getBucket({ bucketId }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          return bucket ? attrsFrom(bucket) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const projectId = yield* resolveProjectId(news.project);
          const logicalId = news.logicalId;
          const bucketId = isPrismaDevId(output?.bucketId)
            ? undefined
            : output?.bucketId;
          let observed: ObservedBucket | undefined = bucketId
            ? yield* getBucket({ bucketId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;
          if (!observed && logicalId !== undefined) {
            observed = yield* findBucketByLogicalId(
              projectId,
              logicalId,
              news.branchId,
            );
          }
          if (!observed) {
            observed = yield* createBucket({
              projectId,
              ...(news.name === undefined ? {} : { name: news.name }),
              ...(news.branchId === undefined || news.branchId === null
                ? {}
                : { branchId: news.branchId }),
              ...(logicalId === undefined ? {} : { logicalId }),
            }).pipe(
              // A replayed create would make a second bucket; the retry policy
              // cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => response.data),
              Effect.catchTag("Conflict", (conflict) =>
                Effect.fail(
                  logicalId === undefined
                    ? conflict
                    : logicalIdTaken(
                        logicalId,
                        news.branchId,
                        projectId,
                        conflict,
                      ),
                ),
              ),
            );
          }
          if (observed.project.id !== projectId) {
            return yield* new BucketProjectMismatchError({
              bucketId: observed.id,
              actualProjectId: observed.project.id,
              expectedProjectId: projectId,
              message: `Prisma bucket '${observed.id}' belongs to project '${observed.project.id}', not requested project '${projectId}'. Refusing to claim convergence; replace the bucket.`,
            });
          }
          const rename = news.name !== undefined && observed.name !== news.name;
          const move =
            news.branchId !== undefined && observed.branchId !== news.branchId;
          if (rename || move) {
            const current = observed;
            observed = yield* updateBucket({
              bucketId: current.id,
              ...(rename ? { displayName: news.name } : {}),
              ...(move ? { branchId: news.branchId } : {}),
            }).pipe(
              Effect.map((response) => response.data),
              // A move is refused when the bucket's logical ID is taken on
              // the target branch.
              Effect.catchTag("Conflict", (conflict) =>
                Effect.fail(
                  current.logicalId
                    ? logicalIdTaken(
                        current.logicalId,
                        news.branchId,
                        projectId,
                        conflict,
                      )
                    : conflict,
                ),
              ),
            );
          }
          if (logicalId !== undefined && observed.logicalId !== logicalId) {
            const { branchId } = observed;
            // The API refuses logicalId in the same request as a branch
            // move, so it is set only after the move above.
            observed = yield* updateBucket({
              bucketId: observed.id,
              logicalId,
            }).pipe(
              Effect.map((response) => response.data),
              Effect.catchTag("Conflict", (conflict) =>
                Effect.fail(
                  logicalIdTaken(logicalId, branchId, projectId, conflict),
                ),
              ),
            );
          }
          return attrsFrom(observed);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.bucketId)) return;
          const bucket = yield* getBucket({
            bucketId: output.bucketId,
          }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!bucket) return;
          if (bucket.project.id !== output.projectId) {
            return yield* new BucketProjectMismatchError({
              bucketId: bucket.id,
              actualProjectId: bucket.project.id,
              expectedProjectId: output.projectId,
              message: `Prisma bucket '${bucket.id}' no longer matches persisted project '${output.projectId}'. Refusing to delete a mismatched bucket.`,
            });
          }
          // Deletion cascades server-side: the Management API removes the
          // bucket together with its objects and any remaining keys.
          yield* deleteBucket({
            bucketId: output.bucketId,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(Bucket, ["bucketId"], ({ id, news }) => ({
    bucketId: devId("bucket", id),
    name: news.name ?? id,
    projectId: attrOrString(news.project, "projectId") ?? devId("project", id),
    createdAt: DEV_TIMESTAMP,
    logicalId: news.logicalId ?? null,
  }));

export const BucketProvider = () =>
  ProviderLayer.dual(Bucket, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
