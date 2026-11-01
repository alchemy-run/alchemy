import * as s3 from "@distilled.cloud/aws/s3";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { type StackitWaitTimeout, waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import { ensureObjectStorageEnabled, withDeployerS3 } from "./internal.ts";

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

/**
 * One statement of an S3 bucket policy, in the JSON form the S3 API takes.
 * STACKIT lists its supported actions under
 * [Supported permissions in bucket policies](https://docs.stackit.cloud/products/storage/object-storage/reference/supported-permissions-in-bucket-policies/).
 */
export interface BucketPolicyStatement {
  /** Statement id. */
  Sid?: string;
  /** Whether the statement allows or denies its actions. */
  Effect: "Allow" | "Deny";
  /**
   * Who the statement applies to: `"*"` for everyone, or a credentials group's
   * `urn` under `AWS`.
   */
  Principal?: "*" | { AWS: string | string[] };
  /** Everyone except these credentials groups. */
  NotPrincipal?: { AWS: string | string[] };
  /** Actions, such as `s3:GetObject`. */
  Action?: string | string[];
  /** Every action except these. */
  NotAction?: string | string[];
  /**
   * Resources, such as `urn:sgws:s3:::my-bucket/*`.
   * @default this bucket and its objects
   */
  Resource?: string | string[];
  /** Conditions, such as `{ IpAddress: { "aws:SourceIp": "192.0.2.0/24" } }`. */
  Condition?: Record<string, Record<string, string | string[]>>;
}

/** An S3 bucket policy document. */
export interface BucketPolicyDocument {
  /** The policy language version. @default "2012-10-17" */
  Version?: string;
  /** The policy's statements. */
  Statement: BucketPolicyStatement[];
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
   * Delete every object, object version and in-progress upload when the
   * bucket is destroyed or replaced. STACKIT only deletes empty buckets, so
   * without this a bucket with objects fails to delete.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * The bucket policy. A statement without `Resource` applies to this bucket and
   * its objects. {@link ReadBucket}, {@link WriteBucket} and
   * {@link ReadWriteBucket} add their own statements to it. If this is omitted
   * and no binding needs a policy, a policy set outside Alchemy stays untouched.
   */
  policy?: BucketPolicyDocument;
  /**
   * CORS rules. Omit to leave the bucket's rules as they are; an empty list
   * removes them.
   */
  cors?: s3.CORSRule[];
  /**
   * Lifecycle rules. Omit to leave the bucket's rules as they are; an empty list
   * removes them.
   */
  lifecycleRules?: s3.LifecycleRule[];
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

/** What a credentials group may do on a bucket, as bindings ask for it. */
export interface BucketAccessGrant {
  /** The credentials group's `urn`. */
  principal: string;
  /** The only S3 actions the group may run on this bucket. */
  actions: string[];
}

/** The binding contract of a {@link Bucket}: statements its policy must carry. */
export interface BucketBinding {
  /** Credentials groups to restrict to the given actions on this bucket. */
  access?: BucketAccessGrant[];
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
    /**
     * The policy Alchemy applied, including the statements bindings added, or
     * `undefined` when Alchemy manages none.
     */
    policy: BucketPolicyDocument | undefined;
    /** The CORS rules Alchemy applied, or `undefined` when unmanaged. */
    cors: s3.CORSRule[] | undefined;
    /** The lifecycle rules Alchemy applied, or `undefined` when unmanaged. */
    lifecycleRules: s3.LifecycleRule[] | undefined;
  },
  BucketBinding,
  Providers
>;

/**
 * A STACKIT Object Storage bucket: S3-compatible storage in a project and
 * region. Reach its objects from a host with {@link ReadBucket},
 * {@link WriteBucket} or {@link ReadWriteBucket}, or from any S3 client using an
 * {@link AccessKey} from a {@link CredentialsGroup}.
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
 * only buckets whose name has the generated shape in the profile's project
 * and region, so a hand-chosen name of that shape is listed too.
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
 * ### Policy, CORS and lifecycle rules
 * These settings live on the S3 API, which only takes Object Storage keys. When
 * a deploy has to change them, or empty a bucket, Alchemy creates a key in the
 * project's `default` credentials group, uses it, and deletes it. The key
 * expires after an hour in any case.
 *
 * **Example:** Public read access for one prefix
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const site = yield* Stackit.ObjectStorage.Bucket("Site", {
 *   bucketName: "my-company-site",
 *   policy: {
 *     Statement: [
 *       {
 *         Sid: "PublicRead",
 *         Effect: "Allow",
 *         Principal: "*",
 *         Action: "s3:GetObject",
 *         Resource: "urn:sgws:s3:::my-company-site/public/*",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Deny one credentials group on this bucket
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.ObjectStorage.CredentialsGroup("Analysts", {});
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Payroll", {
 *   policy: {
 *     Statement: [
 *       {
 *         Effect: "Deny",
 *         Principal: { AWS: group.urn },
 *         Action: "s3:*",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Browser uploads and expiring objects
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const uploads = yield* Stackit.ObjectStorage.Bucket("Uploads", {
 *   cors: [
 *     {
 *       AllowedMethods: ["GET", "PUT"],
 *       AllowedOrigins: ["https://app.example.com"],
 *       ExposeHeaders: ["ETag"],
 *     },
 *   ],
 *   lifecycleRules: [
 *     {
 *       ID: "ExpireTemporary",
 *       Status: "Enabled",
 *       Filter: { Prefix: "tmp/" },
 *       Expiration: { Days: 7 },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Deleting a Bucket with objects
 * **Example:** Empty the bucket on destroy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cache = yield* Stackit.ObjectStorage.Bucket("Cache", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Replacement cautions <!-- api-prose -->
 * Changing `bucketName`, `objectLockEnabled`, `projectId` or `region`
 * replaces the bucket. STACKIT only deletes empty buckets, so set
 * `forceDestroy` or empty the old bucket before the replacement (or destroy)
 * runs. `COMPLIANCE` retention keeps locked objects, and therefore the bucket,
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

/** `forceDestroy` couldn't delete everything in the bucket. */
export class BucketNotEmptied extends Data.TaggedError("Stackit.ObjectStorage.BucketNotEmptied")<{
  readonly bucketName: string;
  readonly message: string;
}> {}

type Attributes = Bucket["Attributes"];

/** The most list pages `forceDestroy` walks: 10 million objects at 1000 per page. */
const MAX_EMPTY_PAGES = 10_000;

/** Longest generated bucket name. */
const BUCKET_NAME_MAX_LENGTH = 63;

const bucketPhysicalName = (id: string) =>
  createPhysicalName({ id, maxLength: BUCKET_NAME_MAX_LENGTH, lowercase: true });

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

/** What a reconcile applied through the S3 API; only `read` can't observe it. */
type AppliedS3Settings = Pick<Attributes, "policy" | "cors" | "lifecycleRules">;

const NO_S3_SETTINGS: AppliedS3Settings = {
  policy: undefined,
  cors: undefined,
  lifecycleRules: undefined,
};

const toAttrs = Effect.fn(function* (
  projectId: string,
  region: string,
  bucket: objectStorage.Bucket,
  applied: AppliedS3Settings,
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
    policy: applied.policy,
    cors: applied.cors,
    lifecycleRules: applied.lifecycleRules,
  } satisfies Attributes;
});

/** A bucket and its objects, as policy resources. */
const bucketResources = (bucketName: string) => [
  `urn:sgws:s3:::${bucketName}`,
  `urn:sgws:s3:::${bucketName}/*`,
];

/**
 * The statements for one credentials group's grant: allow its actions, and deny
 * it everything else on this bucket. A group can otherwise use every bucket in
 * the project, so the `Deny` is what narrows it; the `Allow` keeps the grant
 * working on a project where groups start without access. Only this group is
 * named, so other groups and the deployer's key are unaffected.
 */
const accessStatements = (
  bucketName: string,
  grant: BucketAccessGrant,
  index: number,
): BucketPolicyStatement[] => [
  {
    Sid: `AlchemyAllow${index}`,
    Effect: "Allow",
    Principal: { AWS: grant.principal },
    Action: grant.actions,
    Resource: bucketResources(bucketName),
  },
  {
    Sid: `AlchemyDeny${index}`,
    Effect: "Deny",
    Principal: { AWS: grant.principal },
    NotAction: grant.actions,
    Resource: bucketResources(bucketName),
  },
];

/**
 * The grants in a bucket's bindings, one per credentials group and in a stable
 * order. Bindings of one host and access level share a group.
 */
const accessGrants = (bindings: ReadonlyArray<{ data: BucketBinding }>): BucketAccessGrant[] => {
  const actions = new Map<string, Set<string>>();
  for (const binding of bindings) {
    for (const grant of binding.data.access ?? []) {
      const existing = actions.get(grant.principal) ?? new Set<string>();
      for (const action of grant.actions) existing.add(action);
      actions.set(grant.principal, existing);
    }
  }
  return [...actions.keys()].sort().map((principal) => ({
    principal,
    actions: [...actions.get(principal)!].sort(),
  }));
};

/** The bucket's whole policy: its `policy` prop plus what its bindings need. */
const desiredPolicy = (
  bucketName: string,
  policy: BucketPolicyDocument | undefined,
  grants: readonly BucketAccessGrant[],
): BucketPolicyDocument | undefined =>
  policy === undefined && grants.length === 0
    ? undefined
    : {
        Version: policy?.Version ?? "2012-10-17",
        Statement: [
          ...(policy?.Statement ?? []).map((statement) => ({
            ...statement,
            Resource: statement.Resource ?? bucketResources(bucketName),
          })),
          ...grants.flatMap((grant, index) => accessStatements(bucketName, grant, index)),
        ],
      };

/** A policy read back from S3; unparseable text never matches, so it's rewritten. */
const parsePolicy = (text: string | undefined): Effect.Effect<unknown> =>
  Effect.try({
    try: () => (text === undefined ? undefined : (JSON.parse(text) as unknown)),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));

const syncPolicy = Effect.fn(function* (
  bucketName: string,
  desired: BucketPolicyDocument | undefined,
) {
  const observed = yield* s3.getBucketPolicy({ Bucket: bucketName }).pipe(
    Effect.flatMap((response) => parsePolicy(response.Policy)),
    Effect.catchTag("NoSuchBucketPolicy", () => Effect.undefined),
  );
  if (desired === undefined) {
    if (observed !== undefined) yield* s3.deleteBucketPolicy({ Bucket: bucketName });
    return;
  }
  if (!deepEqual(observed, desired)) {
    yield* s3.putBucketPolicy({ Bucket: bucketName, Policy: JSON.stringify(desired) });
  }
});

/** A CORS rule without what S3 reports differently: unset lists and list order. */
const projectCors = (rules: readonly s3.CORSRule[]) =>
  rules.map((rule) => ({
    AllowedHeaders: [...(rule.AllowedHeaders ?? [])].sort(),
    AllowedMethods: [...rule.AllowedMethods].sort(),
    AllowedOrigins: [...rule.AllowedOrigins].sort(),
    ExposeHeaders: [...(rule.ExposeHeaders ?? [])].sort(),
    MaxAgeSeconds: rule.MaxAgeSeconds,
  }));

const syncCors = Effect.fn(function* (bucketName: string, desired: s3.CORSRule[]) {
  const observed = yield* s3.getBucketCors({ Bucket: bucketName }).pipe(
    Effect.map((response) => response.CORSRules ?? []),
    Effect.catchTag("NoSuchCORSConfiguration", () => Effect.succeed<s3.CORSRule[]>([])),
  );
  if (deepEqual(projectCors(observed), projectCors(desired))) return;
  if (desired.length === 0) {
    yield* s3.deleteBucketCors({ Bucket: bucketName });
  } else {
    yield* s3.putBucketCors({ Bucket: bucketName, CORSConfiguration: { CORSRules: desired } });
  }
});

const syncLifecycle = Effect.fn(function* (bucketName: string, desired: s3.LifecycleRule[]) {
  const observed = yield* s3.getBucketLifecycleConfiguration({ Bucket: bucketName }).pipe(
    Effect.map((response) => response.Rules ?? []),
    Effect.catchTag("NoSuchLifecycleConfiguration", () => Effect.succeed<s3.LifecycleRule[]>([])),
  );
  if (deepEqual(observed, desired)) return;
  if (desired.length === 0) {
    yield* s3.deleteBucketLifecycle({ Bucket: bucketName });
  } else {
    yield* s3.putBucketLifecycleConfiguration({
      Bucket: bucketName,
      LifecycleConfiguration: { Rules: desired },
    });
  }
});

/**
 * Delete every object version, delete marker and in-progress upload. Listing
 * versions also covers an unversioned bucket, and pagination follows
 * `IsTruncated` because S3 may omit the next marker mid-listing.
 */
const emptyBucket = Effect.fn(function* (bucketName: string) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (let page = 0; ; page++) {
    if (page === MAX_EMPTY_PAGES) {
      return yield* new BucketNotEmptied({
        bucketName,
        message: `Bucket ${bucketName} still lists objects after ${MAX_EMPTY_PAGES} pages.`,
      });
    }
    const listed = yield* s3.listObjectVersions({
      Bucket: bucketName,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    });
    const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((entry) => ({
      Key: entry.Key!,
      VersionId: entry.VersionId,
    }));
    if (objects.length > 0) {
      const deleted = yield* s3.deleteObjects({
        Bucket: bucketName,
        Delete: { Objects: objects, Quiet: true },
      });
      const failure = deleted.Errors?.[0];
      if (failure !== undefined) {
        return yield* new BucketNotEmptied({
          bucketName,
          message: `Could not delete ${failure.Key} from bucket ${bucketName}: ${failure.Code} ${failure.Message}`,
        });
      }
    }
    if (listed.IsTruncated !== true) break;
    keyMarker = listed.NextKeyMarker;
    versionIdMarker = listed.NextVersionIdMarker;
  }

  let uploadKeyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  for (let page = 0; page < MAX_EMPTY_PAGES; page++) {
    const uploads = yield* s3.listMultipartUploads({
      Bucket: bucketName,
      KeyMarker: uploadKeyMarker,
      UploadIdMarker: uploadIdMarker,
    });
    yield* Effect.forEach(
      uploads.Uploads ?? [],
      (upload) =>
        s3
          .abortMultipartUpload({
            Bucket: bucketName,
            Key: upload.Key!,
            UploadId: upload.UploadId!,
          })
          .pipe(Effect.catchTag("NoSuchUpload", () => Effect.void)),
      { concurrency: 8 },
    );
    if (uploads.IsTruncated !== true) break;
    uploadKeyMarker = uploads.NextKeyMarker;
    uploadIdMarker = uploads.NextUploadIdMarker;
  }
});

const describeBucket = (bucketName: string, projectId: string, region: string) =>
  `STACKIT bucket ${bucketName} in project ${projectId} (${region})`;

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: ["bucketName", "projectId", "region", "objectLockEnabled"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name can resolve to the current one, and bucket names are
      // unique: it must be freed first. A generated name changes with the new
      // generation, so create-before-delete is safe.
      if (
        hasUnresolvedTrigger<BucketProps>(news, [
          "bucketName",
          "projectId",
          "region",
          "objectLockEnabled",
        ])
      ) {
        return {
          action: "replace" as const,
          deleteFirst: rawProp<BucketProps>(news, "bucketName") !== undefined,
        };
      }
      const resolved = triggerProps<BucketProps>(news);
      const env = yield* StackitEnvironment.current;
      const nameChanged =
        resolved.bucketName !== undefined
          ? resolved.bucketName !== output.bucketName
          : olds?.bucketName !== undefined;
      if (
        nameChanged ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region ||
        (resolved.objectLockEnabled ?? false) !== output.objectLockEnabled
      ) {
        // An explicit, unchanged name must be freed before it can be reused.
        const sameName =
          resolved.bucketName !== undefined && resolved.bucketName === output.bucketName;
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
      const attrs = yield* toAttrs(projectId, region, bucket, {
        policy: output?.policy,
        cors: output?.cors,
        lifecycleRules: output?.lifecycleRules,
      });
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
        listed.filter((bucket) => isGeneratedPhysicalName(bucket.name, BUCKET_NAME_MAX_LENGTH)),
        (bucket) => toAttrs(env.projectId, env.region, bucket, NO_S3_SETTINGS),
        { concurrency: 4 },
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
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

      // 4. Sync what lives on the S3 API, each against its observed state. Only
      // mint a key when the bucket has such settings or had them last deploy.
      const policy = desiredPolicy(bucketName, news.policy, accessGrants(bindings));
      if (
        policy !== undefined ||
        output?.policy !== undefined ||
        news.cors !== undefined ||
        news.lifecycleRules !== undefined
      ) {
        yield* withDeployerS3(
          { projectId, region, bucketName, urlPathStyle: bucket.urlPathStyle },
          Effect.gen(function* () {
            yield* syncPolicy(bucketName, policy);
            if (news.cors !== undefined) yield* syncCors(bucketName, news.cors);
            if (news.lifecycleRules !== undefined) {
              yield* syncLifecycle(bucketName, news.lifecycleRules);
            }
          }),
        );
      }

      // 5. Return fresh attributes.
      return yield* toAttrs(projectId, region, bucket, {
        policy,
        cors: news.cors,
        lifecycleRules: news.lifecycleRules,
      });
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const { projectId, region, bucketName } = output;
      // `force` is set only by `alchemy unsafe nuke`, an operator's explicit
      // teardown. A plain destroy keeps a bucket's objects unless asked.
      if (olds?.forceDestroy === true || force === true) {
        const bucket = yield* getBucket(projectId, region, bucketName);
        if (bucket !== undefined) {
          yield* withDeployerS3(
            { projectId, region, bucketName, urlPathStyle: bucket.urlPathStyle },
            emptyBucket(bucketName),
          ).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
        }
      }
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
