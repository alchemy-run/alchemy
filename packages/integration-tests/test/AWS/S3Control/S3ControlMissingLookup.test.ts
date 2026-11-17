import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:s3control", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (access point, multi region access point, object lambda access point).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-access-point": AWS.S3Control.AccessPoint.lookup({ accessPointName: name })
          .accessPointName,
        "missing-multi-region-access-point": AWS.S3Control.MultiRegionAccessPoint.lookup({
          multiRegionAccessPointName: name,
        }).multiRegionAccessPointName,
        "missing-object-lambda-access-point": AWS.S3Control.ObjectLambdaAccessPoint.lookup({
          objectLambdaAccessPointName: name,
        }).objectLambdaAccessPointName,
      });
    }),
  { tags, timeout: 180_000 },
);
