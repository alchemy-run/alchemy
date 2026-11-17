import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:ssmincidents", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (response plan).
// The testing account can't use SSMIncidents; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_INCIDENT_MANAGER)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-response-plan": AWS.SSMIncidents.ResponsePlan.lookup({ name: name }).arn,
      });
    }),
  { tags, timeout: 180_000 },
);
