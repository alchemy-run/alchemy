import { Region } from "@distilled.cloud/aws/Region";
import type { BucketLocationConstraint } from "@distilled.cloud/aws/s3";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { diffTags } from "../../Tags.ts";
import { Account, type AccountID } from "../Account.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { RegionID } from "../Region.ts";

export type BucketName = string;
export type BucketArn = `arn:aws:s3:::${BucketName}`;

export interface BucketProps {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * Must be lowercase and between 3-63 characters.
   */
  bucketName?: string;
  /**
   * Indicates whether this bucket has Object Lock enabled.
   * Once enabled, cannot be disabled.
   */
  objectLockEnabled?: boolean;
  /**
   * Whether to delete all objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Tags to apply to the bucket.
   */
  tags?: Record<string, string>;
}

export interface Bucket extends Resource<
  "AWS.S3.Bucket",
  BucketProps,
  {
    /**
     * Name of the bucket.
     */
    bucketName: BucketName;
    /**
     * ARN of the bucket.
     */
    bucketArn: BucketArn;
    /**
     * Domain name of the bucket (e.g., bucket-name.s3.amazonaws.com).
     */
    bucketDomainName: `${BucketName}.s3.amazonaws.com`;
    /**
     * Regional domain name of the bucket.
     */
    bucketRegionalDomainName: `${BucketName}.s3.${RegionID}.amazonaws.com`;
    /**
     * AWS region where the bucket is located.
     */
    region: RegionID;
    /**
     * AWS account ID that owns the bucket.
     */
    accountId: AccountID;
  },
  {
    /**
     * Notification configuration for the bucket.
     */
    notificationConfiguration?: s3.NotificationConfiguration;
    /**
     * Policy statements for the bucket.
     */
    policyStatements?: PolicyStatement[];
  }
> {}

export const Bucket = Resource<Bucket>("AWS.S3.Bucket");

export const BucketProvider = () =>
  Bucket.provider.effect(
    Effect.gen(function* () {
      const createBucketName = (
        id: string,
        props: { bucketName?: string | undefined },
      ) =>
        Effect.gen(function* () {
          if (props.bucketName) {
            return props.bucketName;
          }
          return yield* createPhysicalName({
            id,
            maxLength: 63,
            lowercase: true,
          });
        });

      const deleteAllObjects = Effect.fn(function* (bucketName: string) {
        // List and delete all objects (including versions and delete markers)
        let continuationToken: string | undefined;
        do {
          const listResponse = yield* s3.listObjectsV2({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          });

          if (listResponse.Contents && listResponse.Contents.length > 0) {
            yield* s3.deleteObjects({
              Bucket: bucketName,
              Delete: {
                Objects: listResponse.Contents.map((obj) => ({
                  Key: obj.Key!,
                })),
                Quiet: true,
              },
            });
          }

          continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        // Also delete all object versions and delete markers
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        do {
          const listVersionsResponse = yield* s3.listObjectVersions({
            Bucket: bucketName,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          });

          const objectsToDelete = [
            ...(listVersionsResponse.Versions ?? []).map((v) => ({
              Key: v.Key!,
              VersionId: v.VersionId,
            })),
            ...(listVersionsResponse.DeleteMarkers ?? []).map((dm) => ({
              Key: dm.Key!,
              VersionId: dm.VersionId,
            })),
          ];

          if (objectsToDelete.length > 0) {
            yield* s3.deleteObjects({
              Bucket: bucketName,
              Delete: {
                Objects: objectsToDelete,
                Quiet: true,
              },
            });
          }

          keyMarker = listVersionsResponse.NextKeyMarker;
          versionIdMarker = listVersionsResponse.NextVersionIdMarker;
        } while (keyMarker);
      });

      return {
        stables: ["bucketName", "bucketArn", "region", "accountId"],
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          const oldBucketName = yield* createBucketName(id, olds);
          const newBucketName = yield* createBucketName(id, news);
          if (oldBucketName !== newBucketName) {
            return { action: "replace" } as const;
          }
          // Object lock can only be enabled at creation time
          if (
            (olds.objectLockEnabled ?? false) !==
            (news.objectLockEnabled ?? false)
          ) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news = {}, session, bindings }) {
          const region = yield* Region;
          const accountId = yield* Account;
          const bucketName = yield* createBucketName(id, news);

          // For us-east-1, BucketAlreadyOwnedByYou is not thrown, so we need to
          // pre-emptively check if the bucket exists for idempotency
          if (region === "us-east-1") {
            const exists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
              Effect.map(() => true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
              Effect.catch(() => Effect.succeed(false)),
            );

            if (!exists) {
              yield* s3
                .createBucket({
                  Bucket: bucketName,
                  ObjectLockEnabledForBucket: news.objectLockEnabled ?? false,
                })
                .pipe(
                  Effect.retry({
                    while: (e) =>
                      e._tag === "OperationAborted" ||
                      e._tag === "ServiceUnavailable",
                    schedule: Schedule.exponential(100),
                  }),
                );
            }
          } else {
            // For non-us-east-1 regions, we can rely on BucketAlreadyOwnedByYou
            yield* s3
              .createBucket({
                Bucket: bucketName,
                CreateBucketConfiguration: {
                  LocationConstraint: region as BucketLocationConstraint,
                },
                ObjectLockEnabledForBucket: news.objectLockEnabled,
              })
              .pipe(
                Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
                Effect.retry({
                  while: (e) =>
                    e._tag === "OperationAborted" ||
                    e._tag === "ServiceUnavailable",
                  schedule: Schedule.exponential(100),
                }),
              );
          }

          // Wait for bucket to exist (eventual consistency)
          yield* Effect.retry(
            s3.headBucket({ Bucket: bucketName }),
            Schedule.exponential(100).pipe(Schedule.both(Schedule.recurs(10))),
          );

          // Apply tags if provided
          if (news.tags && Object.keys(news.tags).length > 0) {
            yield* s3.putBucketTagging({
              Bucket: bucketName,
              Tagging: {
                TagSet: Object.entries(news.tags).map(([Key, Value]) => ({
                  Key,
                  Value: Value as string,
                })),
              },
            });
          }

          // Apply bucket policy from binding policyStatements
          const policyStatements = bindings.flatMap(
            (b) => b.policyStatements ?? [],
          );
          if (policyStatements.length > 0) {
            yield* s3.putBucketPolicy({
              Bucket: bucketName,
              Policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: policyStatements,
              }),
            });
          }

          yield* session.note(`Created bucket: ${bucketName}`);

          return {
            bucketName,
            bucketArn: `arn:aws:s3:::${bucketName}` as const,
            bucketDomainName: `${bucketName}.s3.amazonaws.com` as const,
            bucketRegionalDomainName:
              `${bucketName}.s3.${region}.amazonaws.com` as const,
            region,
            accountId,
          };
        }),
        update: Effect.fn(function* ({
          news = {},
          olds = {},
          output,
          session,
          bindings,
        }) {
          // Diff tags to determine what changed
          const oldTags = (olds.tags as Record<string, string>) ?? {};
          const newTags = (news.tags as Record<string, string>) ?? {};
          const { removed, upsert } = diffTags(oldTags, newTags);

          // Only update tags if there are actual changes
          if (removed.length > 0 || upsert.length > 0) {
            if (Object.keys(upsert).length > 0) {
              yield* s3.putBucketTagging({
                Bucket: output.bucketName,
                Tagging: {
                  TagSet: Object.entries(newTags).map(([Key, Value]) => ({
                    Key,
                    Value,
                  })),
                },
              });
              yield* session.note(`Updated bucket tags: ${output.bucketName}`);
            } else {
              // All tags removed
              yield* s3.deleteBucketTagging({
                Bucket: output.bucketName,
              });
              yield* session.note(
                `Removed all tags from bucket: ${output.bucketName}`,
              );
            }
          }

          // Apply bucket policy from binding policyStatements
          const policyStatements = bindings.flatMap(
            (b) => b.policyStatements ?? [],
          );
          if (policyStatements.length > 0) {
            const newPolicy = JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            });
            const existingPolicy = yield* s3
              .getBucketPolicy({ Bucket: output.bucketName })
              .pipe(
                Effect.map((r) => r.Policy),
                Effect.catchTag("NoSuchBucketPolicy", () => Effect.void),
              );
            if (existingPolicy !== newPolicy) {
              yield* s3.putBucketPolicy({
                Bucket: output.bucketName,
                Policy: newPolicy,
              });
            }
          } else {
            yield* s3.deleteBucketPolicy({ Bucket: output.bucketName });
          }

          return output;
        }),
        delete: Effect.fn(function* ({ olds = {}, output, session }) {
          // If forceDestroy is enabled, delete all objects first
          if (olds.forceDestroy) {
            yield* session.note(
              `Force destroying bucket: ${output.bucketName} - deleting all objects...`,
            );
            yield* deleteAllObjects(output.bucketName);
          }

          yield* s3
            .deleteBucket({
              Bucket: output.bucketName,
            })
            .pipe(
              Effect.catchTag("NoSuchBucket", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "BucketNotEmpty",
                schedule: Schedule.exponential(100).pipe(
                  Schedule.both(Schedule.recurs(5)),
                ),
              }),
            );

          yield* session.note(`Deleted bucket: ${output.bucketName}`);
        }),
      };
    }),
  );
