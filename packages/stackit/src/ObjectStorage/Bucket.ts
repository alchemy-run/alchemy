import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { type StackitWaitTimeout, waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import { ensureObjectStorageEnabled } from "./internal.ts";

/**
 * Object Lock retention mode for a bucket's default retention.
 *
 * - `GOVERNANCE` — users with the right permissions can shorten or remove
 *   an object's retention.
 * - `COMPLIANCE` — nobody can delete or overwrite a locked object version
 *   until its retention ends.
 */
export type BucketRetentionMode = "COMPLIANCE" | "GOVERNANCE";

/** Default Object Lock retention applied to new objects in a bucket. */
export interface BucketDefaultRetention {
  /** Retention mode. */
  mode: BucketRetentionMode;
  /**
   * Retention period in days. Must not exceed the project's compliance
   * lock `maxRetentionDays`.
   */
  days: number;
}

export interface BucketProps {
  /**
   * Name of the bucket. Must be DNS-conform: 3-63 characters, lowercase
   * letters, digits and hyphens. If omitted, a unique name is generated
   * from the stack, stage and logical id. Changing it replaces the bucket.
   */
  bucketName?: string;
  /**
   * Enable S3 Object Lock on the bucket. Can only be set when the bucket is
   * created and requires an active project-level
   * {@link ComplianceLock}. Changing it replaces the bucket.
   * @default false
   */
  objectLockEnabled?: boolean;
  /**
   * Default retention for new objects. Requires `objectLockEnabled: true`.
   * Updated in place; removing it removes the default retention (Object
   * Lock itself stays enabled).
   */
  defaultRetention?: BucketDefaultRetention;
  /**
   * Project to create the bucket in. Defaults to the profile's project.
   * Changing it replaces the bucket.
   */
  projectId?: string;
  /**
   * Region of the bucket. Defaults to the profile's region (`eu01`).
   * Changing it replaces the bucket.
   */
  region?: string;
}

export type Bucket = Resource<
  "Stackit.ObjectStorage.Bucket",
  BucketProps,
  {
    /** Name of the bucket. */
    bucketName: string;
    /** Project the bucket belongs to. */
    projectId: string;
    /** Region of the bucket. */
    region: string;
    /** Whether S3 Object Lock is enabled on the bucket. */
    objectLockEnabled: boolean;
    /** Path-style S3 URL, e.g. `https://object.storage.eu01.onstackit.cloud/<bucket>`. */
    urlPathStyle: string;
    /** Virtual-hosted-style S3 URL, e.g. `https://<bucket>.object.storage.eu01.onstackit.cloud`. */
    urlVirtualHostedStyle: string;
    /** Observed default retention, or `undefined` when none is set. */
    defaultRetention: BucketDefaultRetention | undefined;
  },
  never,
  Providers
>;

/**
 * A STACKIT Object Storage bucket: S3-compatible storage in a project and
 * region. Access it with the S3 API using an {@link AccessKey} from a
 * {@link CredentialsGroup}.
 *
 * Object Storage is enabled for the project on the first deploy (the
 * service's own idempotent "create project" call); Alchemy never disables
 * it again.
 *
 * Ownership: Object Storage buckets have no labels. Alchemy treats a bucket
 * as its own when it is in the stack's state, or when its name is the
 * generated physical name (which embeds the resource's instance id). An
 * existing bucket with an explicit `bucketName` and no state is reported as
 * unowned and only taken over with `--adopt`. `alchemy unsafe nuke` lists
 * only buckets with generated names in the profile's project and region.
 *
 * ### Creating a Bucket
 * **Example:** Bucket with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Assets", {});
 * ```
 *
 * **Example:** Bucket with an explicit name in another region
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Assets", {
 *   bucketName: "my-company-assets",
 *   region: "eu02",
 * });
 * ```
 *
 * ### Connecting with S3 clients
 * **Example:** Bucket plus credentials for an S3 client
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Assets", {});
 * const group = yield* Stackit.ObjectStorage.CredentialsGroup("AssetsWriters", {});
 * const key = yield* Stackit.ObjectStorage.AccessKey("AssetsKey", {
 *   credentialsGroupId: group.credentialsGroupId,
 * });
 * // S3 endpoint: bucket.urlPathStyle without the bucket name,
 * // access key id: key.accessKeyId, secret: key.secretAccessKey (Redacted).
 * ```
 *
 * ### Object Lock and retention
 * **Example:** Object Lock bucket with a default retention
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const lock = yield* Stackit.ObjectStorage.ComplianceLock("Lock", {});
 * const archive = yield* Stackit.ObjectStorage.Bucket("Archive", {
 *   // referencing the lock orders the bucket after it
 *   projectId: lock.projectId,
 *   objectLockEnabled: true,
 *   defaultRetention: { mode: "GOVERNANCE", days: 30 },
 * });
 * ```
 *
 * ### Replacement cautions <!-- api-prose -->
 * Changing `bucketName`, `objectLockEnabled`, `projectId` or `region`
 * replaces the bucket. STACKIT only deletes empty buckets, so empty the old
 * bucket through the S3 API before the replacement (or destroy) runs.
 * `COMPLIANCE` retention keeps locked objects, and therefore the bucket,
 * until the retention ends.
 *
 * @resource
 * @product STACKIT Object Storage
 * @category Storage
 */
export const Bucket = Resource<Bucket>("Stackit.ObjectStorage.Bucket");

/** The bucket name is taken by a bucket outside this project. */
export class BucketNameUnavailable extends Data.TaggedError(
  "Stackit.ObjectStorage.BucketNameUnavailable",
)<{ readonly bucketName: string; readonly message: string }> {}

/** The deployed bucket's Object Lock setting differs from the desired one. */
export class BucketObjectLockMismatch extends Data.TaggedError(
  "Stackit.ObjectStorage.BucketObjectLockMismatch",
)<{ readonly bucketName: string; readonly message: string }> {}

/** `defaultRetention` was set on a bucket without Object Lock. */
export class BucketObjectLockRequired extends Data.TaggedError(
  "Stackit.ObjectStorage.BucketObjectLockRequired",
)<{ readonly bucketName: string; readonly message: string }> {}

type Attributes = Bucket["Attributes"];

const bucketPhysicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 63, lowercase: true });

const getBucket = (projectId: string, region: string, bucketName: string) =>
  objectStorage.getBucket({ projectId, region, bucketName }).pipe(
    Effect.map((response) => response.bucket),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const getRetention = (projectId: string, region: string, bucketName: string) =>
  objectStorage.getDefaultRetention({ projectId, region, bucketName }).pipe(
    Effect.map((response): BucketDefaultRetention => ({
      mode: response.mode,
      days: response.days,
    })),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const toAttrs = Effect.fn(function* (
  projectId: string,
  region: string,
  bucket: objectStorage.Bucket,
) {
  const defaultRetention = bucket.objectLockEnabled
    ? yield* getRetention(projectId, region, bucket.name)
    : undefined;
  return {
    bucketName: bucket.name,
    projectId,
    region,
    objectLockEnabled: bucket.objectLockEnabled,
    urlPathStyle: bucket.urlPathStyle,
    urlVirtualHostedStyle: bucket.urlVirtualHostedStyle,
    defaultRetention,
  } satisfies Attributes;
});

const describeBucket = (bucketName: string, projectId: string, region: string) =>
  `STACKIT bucket ${bucketName} in project ${projectId} (${region})`;

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: ["bucketName", "projectId", "region", "objectLockEnabled"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      const nameChanged =
        news.bucketName !== undefined
          ? news.bucketName !== output.bucketName
          : olds?.bucketName !== undefined;
      if (
        nameChanged ||
        (news.projectId ?? env.projectId) !== output.projectId ||
        (news.region ?? env.region) !== output.region ||
        (news.objectLockEnabled ?? false) !== output.objectLockEnabled
      ) {
        // An explicit, unchanged name must be freed before it can be reused.
        const sameName = news.bucketName !== undefined && news.bucketName === output.bucketName;
        return { action: "replace" as const, deleteFirst: sameName };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const region = output?.region ?? olds?.region ?? env.region;
      const explicitName = output?.bucketName ?? olds?.bucketName;
      const bucketName = explicitName ?? (yield* bucketPhysicalName(id));
      const bucket = yield* getBucket(projectId, region, bucketName);
      if (bucket === undefined) return undefined;
      const attrs = yield* toAttrs(projectId, region, bucket);
      // No labels: a bucket is ours when it is in state, carries the
      // generated (instance-id) name, or is the generation being replaced.
      const owned =
        output !== undefined || explicitName === undefined || previous?.bucketName === bucket.name;
      return owned ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const listed = yield* objectStorage
        .listBuckets({ projectId: env.projectId, region: env.region })
        .pipe(
          Effect.map((response) => response.buckets),
          // The project was never enabled for Object Storage: no buckets.
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
      return yield* Effect.forEach(
        listed.filter((bucket) => isGeneratedPhysicalName(bucket.name)),
        (bucket) => toAttrs(env.projectId, env.region, bucket),
        { concurrency: 4 },
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;
      const bucketName = news.bucketName ?? output?.bucketName ?? (yield* bucketPhysicalName(id));
      const objectLockEnabled = news.objectLockEnabled ?? false;
      const resource = describeBucket(bucketName, projectId, region);

      yield* ensureObjectStorageEnabled({ projectId, region });

      // 1. Observe.
      let bucket = yield* getBucket(projectId, region, bucketName);

      // 2. Ensure. Creation is asynchronous: wait until GET sees the bucket.
      if (bucket === undefined) {
        const created = yield* objectStorage
          .createBucket({
            projectId,
            region,
            bucketName,
            objectLockEnabled: objectLockEnabled ? true : undefined,
          })
          .pipe(
            Effect.as(true),
            // A concurrent create of ours, or a name taken elsewhere.
            Effect.catchTag("Conflict", () => Effect.succeed(false)),
          );
        bucket = yield* waitFor({
          resource,
          read: getBucket(projectId, region, bucketName),
          ready: (observed) => observed !== undefined,
          state: (observed) => (observed === undefined ? "creating" : "ready"),
          timeout: created ? "5 minutes" : "30 seconds",
        }).pipe(
          Effect.catchTag(
            "Stackit.WaitTimeout",
            (timeout): Effect.Effect<never, StackitWaitTimeout | BucketNameUnavailable> =>
              created
                ? Effect.fail(timeout)
                : Effect.fail(
                    new BucketNameUnavailable({
                      bucketName,
                      message: `Bucket name ${bucketName} is already in use outside project ${projectId} (${region}); choose another bucketName.`,
                    }),
                  ),
          ),
        );
        if (bucket === undefined) {
          return yield* new BucketNameUnavailable({
            bucketName,
            message: `Bucket ${bucketName} did not become visible in project ${projectId} (${region}).`,
          });
        }
      }

      // Object Lock is creation-only; an adopted bucket can't be converted.
      if (bucket.objectLockEnabled !== objectLockEnabled) {
        return yield* new BucketObjectLockMismatch({
          bucketName,
          message: `${resource} has objectLockEnabled=${bucket.objectLockEnabled}, but ${objectLockEnabled} is desired. Object Lock can only be set at creation; use another bucketName to create a new bucket.`,
        });
      }

      // 3. Sync default retention against the observed configuration.
      const desired = news.defaultRetention;
      if (desired !== undefined && !bucket.objectLockEnabled) {
        return yield* new BucketObjectLockRequired({
          bucketName,
          message: `${resource}: defaultRetention requires objectLockEnabled: true.`,
        });
      }
      if (bucket.objectLockEnabled) {
        const observed = yield* getRetention(projectId, region, bucketName);
        if (
          desired !== undefined &&
          (observed?.mode !== desired.mode || observed?.days !== desired.days)
        ) {
          yield* objectStorage.setDefaultRetention({
            projectId,
            region,
            bucketName,
            mode: desired.mode,
            days: desired.days,
          });
        } else if (desired === undefined && observed !== undefined) {
          yield* objectStorage
            .deleteDefaultRetention({ projectId, region, bucketName })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
      }

      // 4. Return fresh attributes.
      return yield* toAttrs(projectId, region, bucket);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { projectId, region, bucketName } = output;
      yield* objectStorage
        .deleteBucket({ projectId, region, bucketName })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: describeBucket(bucketName, projectId, region),
        read: getBucket(projectId, region, bucketName),
        timeout: "5 minutes",
      });
    }),
  });
