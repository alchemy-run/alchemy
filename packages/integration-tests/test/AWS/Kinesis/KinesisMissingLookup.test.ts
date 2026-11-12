import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:kinesis", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (stream consumer).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-stream-consumer": AWS.Kinesis.StreamConsumer.lookup({
          consumerArn: `arn:aws:kinesis:${region}:${accountId}:stream/missing-lookup/consumer/missing-lookup:1700000000`,
        }).consumerArn,
      });
    }),
  { tags, timeout: 180_000 },
);
