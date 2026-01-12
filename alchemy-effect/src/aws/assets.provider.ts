import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as s3 from "distilled-aws/s3";
import { Region } from "distilled-aws/Region";
import { Account } from "./account.ts";
import { Assets, type AssetsError } from "./assets.ts";
import { ASSETS_BUCKET_TAG, getAssetsBucketName } from "./bootstrap.ts";

/**
 * S3 key prefix for Lambda function code assets.
 */
const LAMBDA_PREFIX = "lambda";

/**
 * Generate the S3 key for a Lambda asset.
 */
const getLambdaAssetKey = (hash: string) => `${LAMBDA_PREFIX}/${hash}.zip`;

/**
 * Look up the assets bucket by checking if it exists and has the correct tag.
 * Returns Option.some(bucketName) if found, Option.none() otherwise.
 */
export const lookupAssetsBucket = Effect.gen(function* () {
  const region = yield* Region;
  const accountId = yield* Account;
  const bucketName = getAssetsBucketName(accountId, region);

  // Check if the bucket exists
  const exists = yield* s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.catchAll(() => Effect.succeed(false)),
  );

  if (!exists) {
    return Option.none<string>();
  }

  // Verify it has our tag
  const tagging = yield* s3
    .getBucketTagging({ Bucket: bucketName })
    .pipe(Effect.catchTag("NoSuchTagSet", () => Effect.succeed({ TagSet: [] })));

  const hasAssetsTag = tagging.TagSet?.some(
    (tag) => tag.Key === ASSETS_BUCKET_TAG && tag.Value === "true",
  );

  if (!hasAssetsTag) {
    return Option.none<string>();
  }

  return Option.some(bucketName);
});

/**
 * Create the Assets service implementation for a given bucket.
 */
const createAssetsService = (bucketName: string): typeof Assets.Service => ({
  bucketName,
  uploadAsset: (hash: string, content: Uint8Array) => {
    const key = getLambdaAssetKey(hash);

    return Effect.gen(function* () {
      // Check if asset already exists
      const exists = yield* s3.headObject({ Bucket: bucketName, Key: key }).pipe(
        Effect.map(() => true),
        Effect.catchTag("NotFound", () => Effect.succeed(false)),
      );

      if (exists) {
        yield* Effect.logDebug(`Asset already exists: s3://${bucketName}/${key}`);
        return key;
      }

      // Upload the asset
      yield* s3.putObject({
        Bucket: bucketName,
        Key: key,
        Body: content,
        ContentType: "application/zip",
      });

      yield* Effect.logDebug(`Uploaded asset: s3://${bucketName}/${key}`);
      return key;
    }).pipe(
      Effect.mapError(
        (err): AssetsError => ({
          _tag: "AssetsUploadError",
          message: `Failed to upload asset ${key}`,
          cause: err,
        }),
      ),
    );
  },
  hasAsset: (hash: string) => {
    const key = getLambdaAssetKey(hash);

    return s3.headObject({ Bucket: bucketName, Key: key }).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
      Effect.mapError(
        (err): AssetsError => ({
          _tag: "AssetsCheckError",
          message: `Failed to check asset ${key}`,
          cause: err,
        }),
      ),
    );
  },
});

/**
 * Layer that provides the Assets service.
 * Looks up the assets bucket on initialization.
 * If the bucket doesn't exist, the layer will fail - use `assetsLayerWithFallback` for graceful fallback.
 */
export const assetsLayer = Layer.effect(
  Assets,
  Effect.gen(function* () {
    const maybeBucket = yield* lookupAssetsBucket;

    if (Option.isNone(maybeBucket)) {
      return yield* Effect.fail(
        new Error(
          "Assets bucket not found. Run 'alchemy-effect bootstrap' to create it.",
        ),
      );
    }

    return createAssetsService(maybeBucket.value);
  }),
);

/**
 * Try to create the assets layer, but don't fail if the bucket doesn't exist.
 * Returns Layer.empty if the bucket is not found.
 */
export const assetsLayerWithFallback = () =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const maybeBucket = yield* lookupAssetsBucket;

      if (Option.isNone(maybeBucket)) {
        yield* Effect.logDebug(
          "Assets bucket not found. Lambda will use inline ZipFile deployment.",
        );
        return Layer.empty;
      }

      return Layer.succeed(Assets, createAssetsService(maybeBucket.value));
    }),
  );
