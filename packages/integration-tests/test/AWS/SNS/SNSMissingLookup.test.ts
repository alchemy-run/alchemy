import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:sns", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (platform application).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-platform-application": AWS.SNS.PlatformApplication.lookup({
          platformApplicationArn: `arn:aws:sns:${region}:${accountId}:app/GCM/missing-lookup`,
        }).platformApplicationArn,
      });
    }),
  { tags, timeout: 180_000 },
);
