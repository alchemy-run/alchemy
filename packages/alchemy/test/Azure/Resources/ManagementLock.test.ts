import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getLock = (scope: string, lockName: string) =>
  orUndefinedIfNotFound(resources.GetManagementLockByScope({ scope, lockName }));

const lockGone = (scope: string, lockName: string) =>
  getLock(scope, lockName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (props: {
  level: Azure.Resources.ManagementLockLevel;
  notes?: string;
  name?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const lock = yield* Azure.Resources.ManagementLock("GroupLock", {
      scope: group.resourceGroupId,
      ...props,
    });
    return { group, lock };
  });

test.provider(
  "lock a resource group, change the level, rename, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lock } = yield* stack.deploy(
        program({ level: "CanNotDelete" }),
      );
      expect(lock.level).toEqual("CanNotDelete");
      expect(lock.notes).toBeUndefined();
      const observed = yield* getLock(group.resourceGroupId, lock.lockName);
      expect(observed?.properties.level).toEqual("CanNotDelete");
      expect(observed?.properties.notes).toMatch(/^\[alchemy .+\/GroupLock\]$/);

      // A locked group cannot be deleted out of band.
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const blocked = yield* resources
        .DeleteResourceGroup({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
        })
        .pipe(Effect.result);
      expect(blocked._tag).toEqual("Failure");

      // Level and notes are mutable in place.
      const updated = yield* stack.deploy(
        program({ level: "ReadOnly", notes: "frozen" }),
      );
      expect(updated.lock.lockName).toEqual(lock.lockName);
      const reobserved = yield* getLock(group.resourceGroupId, lock.lockName);
      expect(reobserved?.properties.level).toEqual("ReadOnly");
      expect(reobserved?.properties.notes).toMatch(/^frozen \[alchemy /);
      expect(updated.lock.notes).toEqual("frozen");

      // A new name replaces the lock.
      const renamed = yield* stack.deploy(
        program({ level: "CanNotDelete", name: "alchemy-test-group-lock" }),
      );
      expect(renamed.lock.lockName).toEqual("alchemy-test-group-lock");
      expect(yield* lockGone(group.resourceGroupId, lock.lockName)).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* lockGone(group.resourceGroupId, renamed.lock.lockName),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 600_000,
  },
);
