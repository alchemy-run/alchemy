import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:monitoring", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-notification-channel": GCP.Monitoring.NotificationChannel.lookup({
          name: `projects/${project}/notificationChannels/1`,
        }).name,
      });
    }),
  { tags, timeout: 75000 },
);
