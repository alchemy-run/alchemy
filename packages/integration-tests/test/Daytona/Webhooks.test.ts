import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as webhooks from "@distilled.cloud/daytona/webhooks";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

test.provider(
  "enable webhook delivery for the organization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const enabled = yield* stack.deploy(Daytona.Webhooks("Events", {}));
      expect(enabled.svixApplicationId).not.toEqual("");
      const status = yield* webhooks.getWebhookControllerInitializationStatus({
        organizationId: enabled.organizationId,
      });
      expect(status.svixApplicationId).toEqual(enabled.svixApplicationId);
      // Refreshing re-syncs endpoints without re-initializing.
      const refreshed = yield* stack.deploy(Daytona.Webhooks("Events", { refresh: 1 }));
      expect(refreshed.svixApplicationId).toEqual(enabled.svixApplicationId);
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], exclusive: "daytona:webhooks", timeout: 180_000 },
);
