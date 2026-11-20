import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:eventbridge", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (API destination, archive, connection, endpoint).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-api-destination": AWS.EventBridge.ApiDestination.lookup({
          apiDestinationName: name,
        }).apiDestinationName,
        "missing-archive": AWS.EventBridge.Archive.lookup({ archiveName: name }).archiveName,
        "missing-connection": AWS.EventBridge.Connection.lookup({ connectionName: name })
          .connectionName,
        "missing-endpoint": AWS.EventBridge.Endpoint.lookup({ endpointName: name }).endpointName,
      });
    }),
  { tags, timeout: 180_000 },
);
