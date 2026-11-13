import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:qapps", "live"];

// A lookup of a Q App that doesn't exist, in the standing instance, fails the
// deploy with LookupNotFoundError.
// The testing account can't use QApps; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_QAPPS)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-q-app": AWS.QApps.QApp.lookup({
          instanceId: process.env.QAPPS_INSTANCE_ID!,
          title: name,
        }).appId,
      });
    }),
  { tags, timeout: 180_000 },
);
