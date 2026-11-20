import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:applicationsignals", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (service level objective).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-service-level-objective": AWS.ApplicationSignals.ServiceLevelObjective.lookup({
          sloName: name,
        }).sloName,
      });
    }),
  { tags, timeout: 180_000 },
);
