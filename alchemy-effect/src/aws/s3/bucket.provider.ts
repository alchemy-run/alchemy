import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import type {
  BucketLocationConstraint,
  ListObjectVersionsOutput,
  S3,
} from "itty-aws/s3";

import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import { somePropsAreDifferent } from "../../diff.ts";
import { createPhysicalName } from "../../physical-name.ts";
import { createTagger, createTagsList, hasTags } from "../../tags.ts";
import { Region } from "../region.ts";
import { S3Client } from "./client.ts";
import { Bucket, BucketArn, type BucketAttrs } from "./bucket.ts";

const HOSTED_ZONE_IDS: Record<string, string> = {
  "af-south-1": "Z83WF9RJE8B12",
  "ap-east-1": "ZNB98KWMFR0R6",
  "ap-east-2": "Z064739330DAH7WJVOO93",
  "ap-northeast-1": "Z2M4EHUR26P7ZW",
  "ap-northeast-2": "Z3W03O7B5YMIYP",
  "ap-northeast-3": "Z2YQB5RD63NC85",
  "ap-south-1": "Z11RGJOFQNVJUP",
  "ap-south-2": "Z02976202B4EZMXIPMXF7",
  "ap-southeast-1": "Z3O0J2DXBE1FTB",
  "ap-southeast-2": "Z1WCIGYICN2BYD",
  "ap-southeast-3": "Z01846753K324LI26A3VV",
  "ap-southeast-4": "Z0312387243XT5FE14WFO",
  "ap-southeast-5": "Z08660063OXLMA7F1FJHU",
  "ap-southeast-6": "Z05686083R66JX5C163TC",
  "ap-southeast-7": "Z0031014GXUMRZG6I14G",
  "ca-central-1": "Z1QDHH18159H29",
  "ca-west-1": "Z03565811Z33SLEZTHOUL",
  "cn-north-1": "Z5CN8UMXT92WN",
  "cn-northwest-1": "Z282HJ1KT0DH03",
  "eu-central-1": "Z21DNDUVLTQW6Q",
  "eu-central-2": "Z030506016YDQGETNASS",
  "eu-north-1": "Z3BAZG2TWCNX0D",
  "eu-south-1": "Z30OZKI7KPW7MI",
  "eu-south-2": "Z0081959F7139GRJC19J",
  "eu-west-1": "Z1BKCTXD74EZPE",
  "eu-west-2": "Z3GKZC51ZF0DB4",
  "eu-west-3": "Z3R1K369G5AVDG",
  "il-central-1": "Z09640613K4A3MN55U7GU",
  "me-central-1": "Z06143092I8HRXZRUZROF",
  "me-south-1": "Z1MPMWCPA7YB62",
  "mx-central-1": "Z057606446ZNVQJJ8WOP",
  "sa-east-1": "Z7KQH4QJS55SO",
  "us-east-1": "Z3AQBSTGFYJSTF",
  "us-east-2": "Z2O1EMRO9K5GLX",
  "us-gov-east-1": "Z2NIFVYYW2VKV1",
  "us-gov-west-1": "Z31GFT0UA1I2HV",
  "us-west-1": "Z2F56UZL2M1ACD",
  "us-west-2": "Z3BJ6K6RIION7M",
};

const VALID_LOCATION_CONSTRAINTS: Set<string> = new Set([
  "af-south-1",
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ca-central-1",
  "cn-north-1",
  "cn-northwest-1",
  "EU",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "sa-east-1",
  "us-east-2",
  "us-gov-east-1",
  "us-gov-west-1",
  "us-west-1",
  "us-west-2",
]);

class BucketNotAvailable extends Data.TaggedError("BucketNotAvailable")<{
  bucketName: string;
}> {}

class BucketStillExists extends Data.TaggedError("BucketStillExists")<{
  bucketName: string;
}> {}

class BucketNotEmptyError extends Data.TaggedError("BucketNotEmptyError")<{
  bucketName: string;
  message: string;
}> {}

const waitForBucketAvailable = (
  s3: S3,
  bucketName: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* s3
      .headBucket({ Bucket: bucketName })
      .pipe(
        Effect.catchTag("NotFound", () =>
          Effect.fail(new BucketNotAvailable({ bucketName })),
        ),
      );
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof BucketNotAvailable,
      schedule: Schedule.exponential(100).pipe(
        Schedule.intersect(Schedule.recurs(60)), // Max ~2 minutes
        Schedule.tapOutput(([, attempt]) =>
          session
            ? session.note(
                `Waiting for bucket to be available... (${attempt + 1})`,
              )
            : Effect.void,
        ),
      ),
    }),
  );

const waitForBucketDeleted = (
  s3: S3,
  bucketName: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    yield* s3.headBucket({ Bucket: bucketName }).pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists({ bucketName }))),
      Effect.catchTag("NotFound", () => Effect.void),
    );
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof BucketStillExists,
      schedule: Schedule.exponential(1000).pipe(
        Schedule.intersect(Schedule.recurs(60)), // Max ~5 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(`Waiting for bucket deletion... (${attempt + 1}s)`),
        ),
      ),
    }),
  );

const emptyBucket = (
  s3: S3,
  bucketName: string,
  objectLockEnabled: boolean,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    let totalDeleted = 0;

    // Phase 1: Delete all object versions
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    while (true) {
      const versionsListResult = yield* s3.listObjectVersions({
        Bucket: bucketName,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
        EncodingType: "url",
      });

      const versions = versionsListResult.Versions ?? [];
      if (versions.length > 0) {
        const objectsToDelete = versions.map((v) => ({
          Key: decodeURIComponent(v.Key!),
          VersionId: v.VersionId,
        }));

        yield* s3
          .deleteObjects({
            Bucket: bucketName,
            Delete: {
              Objects: objectsToDelete,
              Quiet: true,
            },
            BypassGovernanceRetention: objectLockEnabled ? true : undefined,
          })
          .pipe(
            Effect.catchTag("AccessDenied", (e) =>
              objectLockEnabled
                ? deleteObjectsWithLegalHoldRemoval(
                    s3,
                    bucketName,
                    objectsToDelete,
                  )
                : Effect.fail(e),
            ),
          );

        totalDeleted += objectsToDelete.length;
        yield* session.note(`Deleted ${totalDeleted} objects...`);
      }

      if (!versionsListResult.IsTruncated) {
        break;
      }
      keyMarker = versionsListResult.NextKeyMarker;
      versionIdMarker = versionsListResult.NextVersionIdMarker;
    }

    // Phase 2: Delete all delete markers
    keyMarker = undefined;
    versionIdMarker = undefined;

    while (true) {
      const markersListResult: ListObjectVersionsOutput =
        yield* s3.listObjectVersions({
          Bucket: bucketName,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
          EncodingType: "url",
        });

      const deleteMarkers = markersListResult.DeleteMarkers ?? [];
      if (deleteMarkers.length > 0) {
        const markersToDelete = deleteMarkers.map(
          (dm: { Key?: string; VersionId?: string }) => ({
            Key: decodeURIComponent(dm.Key!),
            VersionId: dm.VersionId,
          }),
        );

        yield* s3.deleteObjects({
          Bucket: bucketName,
          Delete: {
            Objects: markersToDelete,
            Quiet: true,
          },
        });

        totalDeleted += markersToDelete.length;
        yield* session.note(
          `Deleted ${totalDeleted} objects (including delete markers)...`,
        );
      }

      if (!markersListResult.IsTruncated) {
        break;
      }
      keyMarker = markersListResult.NextKeyMarker;
      versionIdMarker = markersListResult.NextVersionIdMarker;
    }

    return totalDeleted;
  });

const deleteObjectsWithLegalHoldRemoval = (
  s3: S3,
  bucketName: string,
  objects: { Key: string; VersionId?: string }[],
) =>
  Effect.gen(function* () {
    for (const obj of objects) {
      yield* s3
        .putObjectLegalHold({
          Bucket: bucketName,
          Key: obj.Key,
          VersionId: obj.VersionId,
          LegalHold: { Status: "OFF" },
        })
        .pipe(Effect.catchAll(() => Effect.void));

      yield* s3
        .deleteObject({
          Bucket: bucketName,
          Key: obj.Key,
          VersionId: obj.VersionId,
          BypassGovernanceRetention: true,
        })
        .pipe(Effect.catchAll(() => Effect.void));
    }
  });

const tagsEqual = (
  oldTags: Record<string, string> | undefined,
  newTags: Record<string, string> | undefined,
): boolean => {
  const oldKeys = Object.keys(oldTags ?? {});
  const newKeys = Object.keys(newTags ?? {});
  if (oldKeys.length !== newKeys.length) {
    return false;
  }
  for (const key of oldKeys) {
    if (oldTags?.[key] !== newTags?.[key]) {
      return false;
    }
  }
  return true;
};

export const bucketProvider = () =>
  Bucket.provider.effect(
    Effect.gen(function* () {
      const s3 = yield* S3Client;
      const region = yield* Region;
      const tagged = yield* createTagger();

      const createBucketName = (
        id: string,
        props: { bucket?: string; bucketPrefix?: string },
      ) =>
        Effect.gen(function* () {
          if (props.bucket) {
            return props.bucket;
          }
          if (props.bucketPrefix) {
            const suffix = yield* createPhysicalName({
              id,
              maxLength: 63 - props.bucketPrefix.length,
            });
            // Extract just the suffix part (after the generated prefix)
            const generatedSuffix = suffix.split("-").pop() ?? "";
            return `${props.bucketPrefix}${generatedSuffix}`;
          }
          return yield* createPhysicalName({ id, maxLength: 63 });
        });

      const computeOutputAttrs = (
        bucketName: string,
        bucketRegion: string,
        props: { bucketPrefix?: string; objectLockEnabled?: boolean },
      ): BucketAttrs<any> => ({
        id: bucketName,
        bucket: bucketName,
        arn: BucketArn(bucketName),
        bucketDomainName: `${bucketName}.s3.amazonaws.com`,
        bucketPrefix: props.bucketPrefix,
        bucketRegion,
        bucketRegionalDomainName: `${bucketName}.s3.${bucketRegion}.amazonaws.com`,
        hostedZoneId: HOSTED_ZONE_IDS[bucketRegion] ?? "",
        objectLockEnabled: props.objectLockEnabled ?? false,
      });

      return {
        stables: [
          "bucket",
          "arn",
          "bucketDomainName",
          "bucketRegionalDomainName",
          "bucketRegion",
          "hostedZoneId",
          "objectLockEnabled",
        ],

        diff: Effect.fn(function* ({ id, news, olds }) {
          // Check for replacement triggers
          if (
            somePropsAreDifferent(olds, news, [
              "bucket",
              "bucketPrefix",
              "objectLockEnabled",
            ])
          ) {
            return { action: "replace" };
          }

          // Check if computed bucket name would change
          const oldBucketName = yield* createBucketName(id, olds);
          const newBucketName = yield* createBucketName(id, news);
          if (oldBucketName !== newBucketName) {
            return { action: "replace" };
          }

          // Check for update triggers (tags or forceDestroy)
          if (
            !tagsEqual(
              olds.tags as Record<string, string>,
              news.tags as Record<string, string>,
            ) ||
            (olds.forceDestroy ?? false) !== (news.forceDestroy ?? false)
          ) {
            return { action: "update" };
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const bucketName =
            output?.bucket ?? (yield* createBucketName(id, olds));

          // Step 1: Verify bucket exists
          const headResult = yield* s3.headBucket({ Bucket: bucketName }).pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          );

          if (!headResult) {
            return undefined;
          }

          // Step 2: Get bucket location
          const locationResult = yield* s3.getBucketLocation({
            Bucket: bucketName,
          });
          const bucketRegion =
            locationResult.LocationConstraint === "EU"
              ? "eu-west-1"
              : (locationResult.LocationConstraint ?? "us-east-1");

          // Step 3: Get tags
          const tags = yield* s3.getBucketTagging({ Bucket: bucketName }).pipe(
            Effect.map((r) =>
              Object.fromEntries(
                (r.TagSet ?? []).map((t) => [t.Key!, t.Value!]),
              ),
            ),
            Effect.catchTag("NoSuchTagSet", () =>
              Effect.succeed({} as Record<string, string>),
            ),
            Effect.catchTag("NoSuchTagSetError", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );

          // Step 4: Get Object Lock configuration
          const objectLockEnabled = yield* s3
            .getObjectLockConfiguration({ Bucket: bucketName })
            .pipe(
              Effect.map(
                (r) =>
                  r.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled",
              ),
              Effect.catchTag("ObjectLockConfigurationNotFoundError", () =>
                Effect.succeed(false),
              ),
              Effect.catchAll(() => Effect.succeed(false)),
            );

          return {
            id: bucketName,
            bucket: bucketName,
            arn: BucketArn(bucketName),
            bucketDomainName: `${bucketName}.s3.amazonaws.com`,
            bucketPrefix: olds.bucketPrefix,
            bucketRegion,
            bucketRegionalDomainName: `${bucketName}.s3.${bucketRegion}.amazonaws.com`,
            hostedZoneId: HOSTED_ZONE_IDS[bucketRegion] ?? "",
            objectLockEnabled,
            tags,
          } as BucketAttrs<any>;
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const bucketName = yield* createBucketName(id, news);
          const alchemyTags = tagged(id);
          const userTags = (news.tags ?? {}) as Record<string, string>;
          const allTags = { ...alchemyTags, ...userTags };

          // Special handling for us-east-1: check if bucket already exists
          if (region === "us-east-1") {
            const exists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
              Effect.flatMap(() =>
                s3.getBucketTagging({ Bucket: bucketName }).pipe(
                  Effect.map((r) =>
                    Object.fromEntries(
                      (r.TagSet ?? []).map((t) => [t.Key!, t.Value!]),
                    ),
                  ),
                  Effect.catchAll(() =>
                    Effect.succeed({} as Record<string, string>),
                  ),
                ),
              ),
              Effect.map((existingTags) => hasTags(alchemyTags, existingTags)),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            );

            if (exists) {
              yield* session.note(
                `Bucket ${bucketName} already exists (recovering state)`,
              );
              yield* waitForBucketAvailable(s3, bucketName, session);
              return computeOutputAttrs(bucketName, region, news);
            }
          }

          // Build CreateBucket request - only include LocationConstraint for valid regions
          const createBucketConfig =
            region === "us-east-1"
              ? undefined
              : VALID_LOCATION_CONSTRAINTS.has(region)
                ? { LocationConstraint: region as BucketLocationConstraint }
                : undefined;

          yield* s3
            .createBucket({
              Bucket: bucketName,
              CreateBucketConfiguration: createBucketConfig,
              ...(news.objectLockEnabled
                ? { ObjectLockEnabledForBucket: true }
                : {}),
            })
            .pipe(
              Effect.catchTag("BucketAlreadyOwnedByYou", () => {
                // Bucket exists and we own it - treat as success (idempotency)
                return Effect.void;
              }),
            );

          yield* session.note(`Bucket ${bucketName} created`);

          // Wait for bucket to be available
          yield* waitForBucketAvailable(s3, bucketName, session);

          // Set tags (either via PutBucketTagging if not included in create, or always for simplicity)
          if (Object.keys(allTags).length > 0) {
            yield* s3
              .putBucketTagging({
                Bucket: bucketName,
                Tagging: { TagSet: createTagsList(allTags) },
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "NoSuchBucket",
                  schedule: Schedule.exponential(100).pipe(
                    Schedule.intersect(Schedule.recurs(10)),
                  ),
                }),
              );
          }

          return computeOutputAttrs(bucketName, region, news);
        }),

        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const bucketName = output.bucket;

          // Update tags if changed
          const oldTags = (olds.tags ?? {}) as Record<string, string>;
          const newUserTags = (news.tags ?? {}) as Record<string, string>;

          if (!tagsEqual(oldTags, newUserTags)) {
            const alchemyTags = tagged(id);
            const allNewTags = { ...alchemyTags, ...newUserTags };

            if (Object.keys(allNewTags).length > 0) {
              yield* s3
                .putBucketTagging({
                  Bucket: bucketName,
                  Tagging: { TagSet: createTagsList(allNewTags) },
                })
                .pipe(
                  Effect.retry({
                    while: (e) => e._tag === "NoSuchBucket",
                    schedule: Schedule.exponential(100).pipe(
                      Schedule.intersect(Schedule.recurs(10)),
                    ),
                  }),
                );
              yield* session.note("Updated bucket tags");
            } else {
              yield* s3.deleteBucketTagging({ Bucket: bucketName }).pipe(
                Effect.retry({
                  while: (e) => e._tag === "NoSuchBucket",
                  schedule: Schedule.exponential(100).pipe(
                    Schedule.intersect(Schedule.recurs(10)),
                  ),
                }),
              );
              yield* session.note("Removed bucket tags");
            }
          }

          // forceDestroy is stored in props, no API call needed
          if ((olds.forceDestroy ?? false) !== (news.forceDestroy ?? false)) {
            yield* session.note(
              `Updated forceDestroy: ${news.forceDestroy ?? false}`,
            );
          }

          return output;
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          const bucketName = output.bucket;
          const forceDestroy = olds.forceDestroy ?? false;
          const objectLockEnabled = output.objectLockEnabled ?? false;

          yield* session.note(`Deleting bucket: ${bucketName}`);

          const deleteBucket = () =>
            s3
              .deleteBucket({ Bucket: bucketName })
              .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));

          yield* deleteBucket().pipe(
            Effect.catchTag("BucketNotEmpty", () =>
              Effect.gen(function* () {
                if (!forceDestroy) {
                  return yield* Effect.fail(
                    new BucketNotEmptyError({
                      bucketName,
                      message:
                        "Bucket is not empty. Set forceDestroy: true to delete all objects.",
                    }),
                  );
                }

                yield* session.note("Emptying bucket...");
                const deleted = yield* emptyBucket(
                  s3,
                  bucketName,
                  objectLockEnabled,
                  session,
                );
                yield* session.note(`Emptied ${deleted} objects`);

                // Retry deletion after emptying
                yield* deleteBucket();
              }),
            ),
          );

          // Wait for bucket to be deleted
          yield* waitForBucketDeleted(s3, bucketName, session);

          yield* session.note(`Bucket ${bucketName} deleted successfully`);
        }),
      };
    }),
  );
