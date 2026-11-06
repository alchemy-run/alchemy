import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:datasync", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (location S3, location efs, task).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-location-efs": AWS.DataSync.LocationEfs.lookup({
          locationArn: `arn:aws:datasync:${region}:${accountId}:location/loc-00000000000000000`,
        }).locationArn,
        "missing-location-s3": AWS.DataSync.LocationS3.lookup({
          locationArn: `arn:aws:datasync:${region}:${accountId}:location/loc-00000000000000000`,
        }).locationArn,
        "missing-task": AWS.DataSync.Task.lookup({
          taskArn: `arn:aws:datasync:${region}:${accountId}:task/task-00000000000000000`,
        }).taskArn,
      });
    }),
  { tags, timeout: 180_000 },
);
