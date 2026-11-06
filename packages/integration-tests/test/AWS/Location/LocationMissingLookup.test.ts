import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:location", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (API key, geofence collection, map, place index, route calculator, tracker).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-api-key": AWS.Location.ApiKey.lookup({ keyName: name }).keyName,
        "missing-geofence-collection": AWS.Location.GeofenceCollection.lookup({
          collectionName: name,
        }).collectionName,
        "missing-map": AWS.Location.Map.lookup({ mapName: name }).mapName,
        "missing-place-index": AWS.Location.PlaceIndex.lookup({ indexName: name }).indexName,
        "missing-route-calculator": AWS.Location.RouteCalculator.lookup({ calculatorName: name })
          .calculatorName,
        "missing-tracker": AWS.Location.Tracker.lookup({ trackerName: name }).trackerName,
      });
    }),
  { tags, timeout: 180_000 },
);
