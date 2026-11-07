import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:datastream", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-connection-profile": GCP.Datastream.ConnectionProfile.lookup({
          connectionProfileId: name,
        }).name,
        "missing-private-connection": GCP.Datastream.PrivateConnection.lookup({
          privateConnectionId: name,
        }).name,
        "missing-private-connections-route": GCP.Datastream.PrivateConnectionsRoute.lookup({
          routeId: name,
          privateConnection: name,
        }).name,
        "missing-stream": GCP.Datastream.Stream.lookup({ streamId: name }).name,
      });
    }),
  { tags, timeout: 120000 },
);
