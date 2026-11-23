import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:frauddetector", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (detector, entity type, event type, label, list, outcome, variable).
// The testing account can't use FraudDetector; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_FRAUDDETECTOR)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      // Lists and variables are named with lowercase letters, digits and underscores only.
      const snake = name.replace(/[^0-9a-z_]/g, "_");
      yield* expectAllMissing(stack, {
        "missing-detector": AWS.FraudDetector.Detector.lookup({ detectorId: name }).detectorId,
        "missing-entity-type": AWS.FraudDetector.EntityType.lookup({ name: name }).name,
        "missing-event-type": AWS.FraudDetector.EventType.lookup({ name: name }).name,
        "missing-label": AWS.FraudDetector.Label.lookup({ name: name }).name,
        "missing-list": AWS.FraudDetector.List.lookup({ name: snake }).name,
        "missing-outcome": AWS.FraudDetector.Outcome.lookup({ name: name }).name,
        "missing-variable": AWS.FraudDetector.Variable.lookup({ name: snake }).name,
      });
    }),
  { tags, timeout: 180_000 },
);
