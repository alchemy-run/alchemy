import { Command, Options } from "@effect/cli";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import { NodeContext } from "@effect/platform-node";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { randomBytes } from "crypto";
import { S3Client, client as s3ClientLayer } from "../aws/s3.ts";
import * as Region from "../aws/region.ts";
import * as Credentials from "../aws/credentials.ts";
import type { S3 } from "itty-aws/s3";

/**
 * Options for the bootstrap-s3 command
 */
const prefix = Options.text("prefix").pipe(
  Options.withDescription("Bucket name prefix (default: alchemy-state)"),
  Options.withDefault("alchemy-state"),
);

const region = Options.text("region").pipe(
  Options.withDescription("AWS region for the bucket"),
  Options.optional,
);

// Note: To use a specific AWS profile, set the AWS_PROFILE environment variable
// e.g., AWS_PROFILE=my-profile alchemy-effect bootstrap-s3 --region us-east-1

/**
 * Bootstrap command to create an S3 bucket for state storage.
 *
 * Usage:
 *   alchemy-effect bootstrap-s3 --region us-east-1
 *   alchemy-effect bootstrap-s3 --prefix my-app-state --region us-west-2
 *   alchemy-effect bootstrap-s3 --profile my-aws-profile
 */
export const bootstrapS3Command = Command.make(
  "bootstrap-s3",
  { prefix, region },
  ({ prefix, region: regionOpt }) => {
    // Determine region from option or environment
    const regionValue = Option.isSome(regionOpt)
      ? regionOpt.value
      : process.env.AWS_REGION ?? "us-east-1";

    return Effect.gen(function* () {
      const s3 = yield* S3Client;

      // Check for existing bucket with our tag
      yield* Console.log("Checking for existing alchemy state bucket...");

      // List buckets and check tags (Resource Groups Tagging API requires more setup,
      // so we use a simpler approach: list buckets, check tags on each)
      const existingBucket = yield* findExistingBucket(s3).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      );

      if (existingBucket) {
        yield* Console.log(`\nFound existing bucket: ${existingBucket}`);
        yield* Console.log("\nUse it in your defineStack:");
        yield* Console.log(
          `  state: S3StateStore.s3({ bucketName: "${existingBucket}" })`,
        );
        return;
      }

      // Create new bucket with random suffix
      const suffix = randomBytes(3).toString("hex");
      const bucketName = `${prefix}-${suffix}`;

      yield* Console.log(`Creating bucket: ${bucketName}...`);

      // Create the bucket
      // Note: For us-east-1, CreateBucketConfiguration should be omitted
      yield* s3
        .createBucket({
          Bucket: bucketName,
          ...(regionValue !== "us-east-1" && {
            CreateBucketConfiguration: {
              LocationConstraint: regionValue,
            },
          }),
        })
        .pipe(
          Effect.catchAll((e) =>
            Effect.fail(new Error(`Failed to create bucket: ${e}`)),
          ),
        );

      // Tag the bucket for identification
      yield* s3
        .putBucketTagging({
          Bucket: bucketName,
          Tagging: {
            TagSet: [
              { Key: "alchemy:bootstrap", Value: "s3-state-store" },
              { Key: "Purpose", Value: "Alchemy state storage" },
              { Key: "CreatedBy", Value: "alchemy-effect-cli" },
            ],
          },
        })
        .pipe(
          Effect.catchAll((e) =>
            Effect.fail(new Error(`Failed to tag bucket: ${e}`)),
          ),
        );

      yield* Console.log(`\nCreated bucket: ${bucketName}`);
      yield* Console.log("\nAdd to your defineStack:");
      yield* Console.log(
        `  import * as S3StateStore from "alchemy-effect/aws/s3-state-store";`,
      );
      yield* Console.log("");
      yield* Console.log(`  export default defineStack("my-app", {`);
      yield* Console.log(`    resources: [/* your resources */],`);
      yield* Console.log(`    providers: AWS.providers(),`);
      yield* Console.log(
        `    state: S3StateStore.s3({ bucketName: "${bucketName}" }),`,
      );
      yield* Console.log(`  });`);
    }).pipe(
      Effect.provide(
        s3ClientLayer().pipe(
          Layer.provide(Region.of(regionValue)),
          // Use default credential chain - respects AWS_PROFILE env var
          Layer.provide(Credentials.fromChain()),
        ),
      ),
      Effect.provide(NodeContext.layer),
      Effect.provide(FetchHttpClient.layer),
    );
  },
);

/**
 * Find an existing bucket tagged with alchemy:bootstrap=s3-state-store
 */
const findExistingBucket = (s3: S3) =>
  Effect.gen(function* () {
    // List all buckets
    const buckets = yield* s3.listBuckets({});

    if (!buckets.Buckets) {
      return undefined;
    }

    // Check each bucket for our tag
    for (const bucket of buckets.Buckets) {
      if (!bucket.Name) continue;

      const tags = yield* s3
        .getBucketTagging({ Bucket: bucket.Name })
        .pipe(Effect.catchAll(() => Effect.succeed({ TagSet: [] })));

      const hasTag = tags.TagSet?.some(
        (tag) =>
          tag.Key === "alchemy:bootstrap" && tag.Value === "s3-state-store",
      );

      if (hasTag) {
        return bucket.Name;
      }
    }

    return undefined;
  });
