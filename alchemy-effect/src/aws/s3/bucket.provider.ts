import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { createPhysicalName } from "../../physical-name.ts";
import { diffTags } from "../../tags.ts";
import { Account } from "../account.ts";
import { Region } from "distilled-aws/Region";
import { Bucket } from "./bucket.ts";
import * as s3 from "distilled-aws/s3";
import type { BucketLocationConstraint } from "distilled-aws/s3";

export const bucketProvider = () =>
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
        diff: Effect.fn(function* ({ id, news, olds }) {
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
        create: Effect.fn(function* ({ id, news, session }) {
          const region = yield* Region;
          const accountId = yield* Account;
          const bucketName = yield* createBucketName(id, news);

          // For us-east-1, BucketAlreadyOwnedByYou is not thrown, so we need to
          // pre-emptively check if the bucket exists for idempotency
          if (region === "us-east-1") {
            const exists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
              Effect.map(() => true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
              Effect.catchAll(() => Effect.succeed(false)),
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
                      e.name === "OperationAborted" ||
                      e.name === "ServiceUnavailable",
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
                    e.name === "OperationAborted" ||
                    e.name === "ServiceUnavailable",
                  schedule: Schedule.exponential(100),
                }),
              );
          }

          // Wait for bucket to exist (eventual consistency)
          yield* Effect.retry(
            s3.headBucket({ Bucket: bucketName }),
            Schedule.exponential(100).pipe(
              Schedule.intersect(Schedule.recurs(10)),
            ),
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
        update: Effect.fn(function* ({ news, olds, output, session }) {
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

          return output;
        }),
        delete: Effect.fn(function* ({ olds, output, session }) {
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
                while: (e) => e.name === "BucketNotEmpty",
                schedule: Schedule.exponential(100).pipe(
                  Schedule.intersect(Schedule.recurs(5)),
                ),
              }),
            );

          yield* session.note(`Deleted bucket: ${output.bucketName}`);
        }),
      };
    }),
  );
