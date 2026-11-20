import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

// Daytona Cloud (v0.229) does not serve the default-queue-timeout route; set
// DAYTONA_TEST_QUEUE_TIMEOUT=1 against a deployment that does.
const queueTimeout = !!process.env.DAYTONA_TEST_QUEUE_TIMEOUT;

test.provider.skipIf(queueTimeout)(
  "a deployment without the queue-timeout route fails with DefaultQueueTimeoutUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(Daytona.OrganizationSettings("Settings", { defaultQueueTimeout: "90 seconds" }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("DefaultQueueTimeoutUnavailable");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:daytona", "live"],
    exclusive: "daytona:organization-settings",
    timeout: 120_000,
  },
);

test.provider.skipIf(!queueTimeout)(
  "change the default queue timeout and restore it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const settings = yield* stack.deploy(
        Daytona.OrganizationSettings("Settings", { defaultQueueTimeout: "90 seconds" }),
      );
      expect(settings.defaultQueueTimeout).toEqual(90);
      const before = settings.original.defaultQueueTimeout;
      expect(
        (yield* organizations.getOrganization({ organizationId: settings.organizationId }))
          .defaultQueueTimeout,
      ).toEqual(90);

      yield* stack.destroy();
      const restored = yield* organizations.getOrganization({
        organizationId: settings.organizationId,
      });
      expect(restored.defaultQueueTimeout).toEqual(before);
    }),
  {
    tags: ["provider:daytona", "live"],
    exclusive: "daytona:organization-settings",
    timeout: 120_000,
  },
);
