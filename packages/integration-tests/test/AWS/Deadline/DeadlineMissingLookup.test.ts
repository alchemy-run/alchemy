import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:deadline", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (budget, farm, fleet, monitor, queue, storage profile).
// The testing account can't use Deadline; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_DEADLINE)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-budget": AWS.Deadline.Budget.lookup({
          farmId: "farm-00000000000000000000000000000000",
          displayName: name,
        }).farmId,
        "missing-farm": AWS.Deadline.Farm.lookup({ displayName: name }).farmId,
        "missing-fleet": AWS.Deadline.Fleet.lookup({
          farmId: "farm-00000000000000000000000000000000",
          displayName: name,
        }).farmId,
        "missing-monitor": AWS.Deadline.Monitor.lookup({ subdomain: name }).monitorId,
        "missing-queue": AWS.Deadline.Queue.lookup({
          farmId: "farm-00000000000000000000000000000000",
          displayName: name,
        }).farmId,
        "missing-storage-profile": AWS.Deadline.StorageProfile.lookup({
          farmId: "farm-00000000000000000000000000000000",
          displayName: name,
        }).farmId,
      });
    }),
  { tags, timeout: 180_000 },
);
