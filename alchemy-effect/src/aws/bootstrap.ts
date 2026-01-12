import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as s3 from "distilled-aws/s3";
import type { BucketLocationConstraint } from "distilled-aws/s3";
import { Region } from "distilled-aws/Region";
import { Account } from "./account.ts";
import { base32 } from "../physical-name.ts";

/**
 * Tag key used to identify the alchemy assets bucket.
 */
export const ASSETS_BUCKET_TAG = "alchemy::assets-bucket";

/**
 * Creates the alchemy assets bucket name for a given account and region.
 * Format: alchemy-assets-{region}-{base32(accountId)}
 *
 * This is a pure function (no Effect) to avoid requiring InstanceId context.
 */
export const getAssetsBucketName = (accountId: string, region: string) => {
  // Pad accountId to 16 chars for consistent base32 encoding
  const paddedAccountId = accountId.padStart(16, "0");
  const suffix = base32(Buffer.from(paddedAccountId, "hex")).slice(0, 16);
  return `alchemy-assets-${region}-${suffix}`.toLowerCase();
};

/**
 * Bootstrap the AWS environment by creating the assets bucket.
 *
 * This is idempotent - running it multiple times is safe.
 * The bucket is tagged with `alchemy::assets-bucket: "true"` for lookup.
 */
export const bootstrap = Effect.fn(function* () {
  const region = yield* Region;
  const accountId = yield* Account;
  const bucketName = getAssetsBucketName(accountId, region);

  yield* Effect.logInfo(`Bootstrapping alchemy assets bucket: ${bucketName}`);

  // Check if bucket already exists
  const exists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.catchAll(() => Effect.succeed(false)),
  );

  if (exists) {
    // Verify it has our tag
    const tagging = yield* s3
      .getBucketTagging({ Bucket: bucketName })
      .pipe(Effect.catchTag("NoSuchTagSet", () => Effect.succeed({ TagSet: [] })));

    const hasAssetsTag = tagging.TagSet?.some(
      (tag) => tag.Key === ASSETS_BUCKET_TAG && tag.Value === "true",
    );

    if (hasAssetsTag) {
      yield* Effect.logInfo(`Assets bucket already exists: ${bucketName}`);
      return { bucketName, created: false };
    }

    // Bucket exists but doesn't have our tag - add it
    yield* Effect.logInfo(`Adding alchemy tag to existing bucket: ${bucketName}`);
    const existingTags = tagging.TagSet ?? [];
    yield* s3.putBucketTagging({
      Bucket: bucketName,
      Tagging: {
        TagSet: [...existingTags, { Key: ASSETS_BUCKET_TAG, Value: "true" }],
      },
    });

    return { bucketName, created: false };
  }

  // Create the bucket
  if (region === "us-east-1") {
    yield* s3
      .createBucket({
        Bucket: bucketName,
      })
      .pipe(
        Effect.retry({
          while: (e) =>
            e.name === "OperationAborted" || e.name === "ServiceUnavailable",
          schedule: Schedule.exponential(100),
        }),
      );
  } else {
    yield* s3
      .createBucket({
        Bucket: bucketName,
        CreateBucketConfiguration: {
          LocationConstraint: region as BucketLocationConstraint,
        },
      })
      .pipe(
        Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
        Effect.retry({
          while: (e) =>
            e.name === "OperationAborted" || e.name === "ServiceUnavailable",
          schedule: Schedule.exponential(100),
        }),
      );
  }

  // Wait for bucket to exist (eventual consistency)
  yield* Effect.retry(
    s3.headBucket({ Bucket: bucketName }),
    Schedule.exponential(100).pipe(Schedule.intersect(Schedule.recurs(10))),
  );

  // Tag the bucket
  yield* s3.putBucketTagging({
    Bucket: bucketName,
    Tagging: {
      TagSet: [{ Key: ASSETS_BUCKET_TAG, Value: "true" }],
    },
  });

  yield* Effect.logInfo(`Created assets bucket: ${bucketName}`);

  return { bucketName, created: true };
});
