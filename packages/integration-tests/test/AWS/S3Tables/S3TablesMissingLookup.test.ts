import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:s3tables", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (namespace, table, table bucket).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-namespace": AWS.S3Tables.Namespace.lookup({
          tableBucketArn: `arn:aws:s3tables:${region}:${accountId}:bucket/${name}`,
          namespace: "missing_lookup",
        }).tableBucketArn,
        "missing-table": AWS.S3Tables.Table.lookup({
          tableBucketArn: `arn:aws:s3tables:${region}:${accountId}:bucket/${name}`,
          namespace: "missing_lookup",
          name: "missing_lookup",
        }).tableArn,
        "missing-table-bucket": AWS.S3Tables.TableBucket.lookup({ name: name }).tableBucketArn,
      });
    }),
  { tags, timeout: 180_000 },
);
