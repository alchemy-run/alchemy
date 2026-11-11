import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:elbv2", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (trust store).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-trust-store": AWS.ELBv2.TrustStore.lookup({
          trustStoreArn: `arn:aws:elasticloadbalancing:${region}:${accountId}:truststore/${name.slice(0, 32)}/0000000000000000`,
        }).trustStoreArn,
      });
    }),
  { tags, timeout: 180_000 },
);
