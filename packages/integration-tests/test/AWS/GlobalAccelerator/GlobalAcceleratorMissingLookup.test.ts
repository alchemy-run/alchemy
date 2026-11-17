import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:globalaccelerator", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (accelerator, listener).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-accelerator": AWS.GlobalAccelerator.Accelerator.lookup({ name }).acceleratorArn,
        "missing-listener": AWS.GlobalAccelerator.Listener.lookup({
          listenerArn: `arn:aws:globalaccelerator::${accountId}:accelerator/11111111-1111-4111-8111-111111111111/listener/00000000`,
        }).listenerArn,
      });
    }),
  { tags, timeout: 180_000 },
);
