import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:guardduty", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (detector, filter).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-detector": AWS.GuardDuty.Detector.lookup({ detectorId: name }).detectorId,
        "missing-filter": AWS.GuardDuty.Filter.lookup({
          detectorId: "0123456789abcdef0123456789abcdef",
          name,
        }).detectorId,
      });
    }),
  { tags, timeout: 180_000 },
);
