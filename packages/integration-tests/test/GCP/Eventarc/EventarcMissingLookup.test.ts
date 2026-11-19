import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:eventarc", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-channel": GCP.Eventarc.Channel.lookup({ channelId: name }).name,
        "missing-channel-connection": GCP.Eventarc.ChannelConnection.lookup({
          channelConnectionId: name,
        }).name,
        "missing-enrollment": GCP.Eventarc.Enrollment.lookup({ enrollmentId: name }).name,
        "missing-google-api-source": GCP.Eventarc.GoogleApiSource.lookup({
          googleApiSourceId: name,
        }).name,
        "missing-message-bus": GCP.Eventarc.MessageBus.lookup({ messageBusId: name }).name,
        "missing-pipeline": GCP.Eventarc.Pipeline.lookup({ pipelineId: name }).name,
        "missing-trigger": GCP.Eventarc.Trigger.lookup({ triggerId: name }).name,
      });
    }),
  { tags, timeout: 165000 },
);
