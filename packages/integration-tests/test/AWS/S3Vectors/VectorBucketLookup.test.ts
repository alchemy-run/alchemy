import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as s3vectors from "@distilled.cloud/aws/s3vectors";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:s3vectors", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "VectorBucketLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bucket = yield* AWS.S3Vectors.VectorBucket("lookup-target");
    return {
      vectorBucketName: bucket.vectorBucketName.as<string>(),
      vectorBucketArn: bucket.vectorBucketArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up vector bucket resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { vectorBucketName, vectorBucketArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { arn: AWS.S3Vectors.VectorBucket.lookup({ vectorBucketName }).vectorBucketArn };
        },
        {
          arn: vectorBucketArn,
        },
      );
      const survivor = yield* s3vectors.getVectorBucket({ vectorBucketName });
      expect(survivor.vectorBucket?.vectorBucketArn).toBe(vectorBucketArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing vector bucket fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-bucket": AWS.S3Vectors.VectorBucket.lookup({ vectorBucketName: name })
          .vectorBucketArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a vector bucket this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.S3Vectors.VectorBucket("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-vector-bucket-consumer", {
              value: AWS.S3Vectors.VectorBucket.lookup({ vectorBucketName: attrs.vectorBucketName })
                .vectorBucketArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
