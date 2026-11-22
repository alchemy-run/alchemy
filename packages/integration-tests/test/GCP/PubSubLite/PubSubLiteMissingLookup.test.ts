import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:pubsublite", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-admin-reservation": GCP.PubSubLite.AdminReservation.lookup({ reservationId: name })
          .name,
        "missing-admin-subscription": GCP.PubSubLite.AdminSubscription.lookup({
          subscriptionId: name,
        }).name,
        "missing-admin-topic": GCP.PubSubLite.AdminTopic.lookup({ topicId: name }).name,
      });
    }),
  { tags, timeout: 105000 },
);
